import { useEffect, useRef, useState } from 'react';
import type { BuildOptions, CMYK, IRDocument } from '@f2a/schema';
import { applyColors, autoCmyk, collectColors, type AutoColor, type AutoMethod, type ColorOverride, type ColorUse } from './colors';
import { fitAssetsToPpi, resizeLine } from './images';
import { ppiLabel, t, type Locale } from './i18n';
import { downloadBytes, zipStore } from './zip';
import { formatMm, PAPERS, paperById, recommendPpi, type PageMeasure, type Ppi } from '../paper';

const SERVER = 'http://localhost:7531';

interface Asset {
  ref: string;
  bytes: Uint8Array;
}

interface BuildResult {
  ok: boolean;
  created?: number;
  warnings?: string[];
  error?: string;
}

interface Proof {
  proof: string;
  de: number;
}

interface ConvertResult {
  ok: boolean;
  rgb: AutoColor[];
  proof: Proof[];
  error?: string;
}

interface Settings {
  options: BuildOptions;
  bleedValue: number;
  neutralsToK: boolean;
  autoMethod: AutoMethod;
  locale: Locale;
  /** Keyed by Figma hex, shared across files. */
  overrides: Record<string, ColorOverride>;
}

type PluginMessage =
  | { type: 'selection'; count: number; names: string[]; pages: PageMeasure[] }
  | { type: 'settings'; settings: Partial<Settings> | null }
  | { type: 'payload'; doc: IRDocument; assets: Asset[] }
  | { type: 'error'; message: string };

const DEFAULTS: Settings = {
  options: { colorMode: 'CMYK', trimboxFromSlice: true, bleedMm: null, paperFormat: 'auto', ppi: 300, embedImages: true },
  bleedValue: 3,
  neutralsToK: true,
  autoMethod: 'closest',
  locale: 'en',
  overrides: {},
};

const PPI_CHOICES: Ppi[] = [72, 150, 300];
const INKS = ['C', 'M', 'Y', 'K'];
/** CIEDE2000 above this is a clearly visible difference between screen and print. */
const VISIBLE_DE = 5;

const proofKey = (c: CMYK, hex: string) => `${c.join(',')}|${hex}`;
const post = (pluginMessage: unknown) => parent.postMessage({ pluginMessage }, '*');

let sessionToken = '';

async function api<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Manifest-Token': sessionToken },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: T & { ok?: boolean; error?: string };
  try {
    data = JSON.parse(text) as T & { ok?: boolean; error?: string };
  } catch {
    throw new Error(res.ok ? 'invalid JSON' : `HTTP ${res.status}`);
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function App() {
  const [online, setOnline] = useState(false);
  const [selection, setSelection] = useState<{ count: number; names: string[]; pages: PageMeasure[] }>({ count: 0, names: [], pages: [] });
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [pending, setPending] = useState<{ doc: IRDocument; assets: Asset[] } | null>(null);
  const [colors, setColors] = useState<ColorUse[]>([]);
  const [autos, setAutos] = useState<Record<string, AutoColor>>({});
  const [proofs, setProofs] = useState<Record<string, Proof>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings);
  const onlineRef = useRef(online);
  const afterExportRef = useRef<(doc: IRDocument, assets: Asset[]) => Promise<void>>(async () => {});
  settingsRef.current = settings;
  onlineRef.current = online;

  const { options, overrides, neutralsToK, autoMethod, locale } = settings;
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);

  const page = selection.pages[0];
  const detected = page?.paper ?? null;
  const activePaper = options.paperFormat === 'auto' ? paperById(detected ?? '') : paperById(options.paperFormat);
  const measureW = activePaper?.w ?? page?.wMm ?? 210;
  const measureH = activePaper?.h ?? page?.hMm ?? 297;
  const rec = recommendPpi(measureW, measureH);
  const mixed = new Set(selection.pages.map((p) => p.paper ?? 'custom'));
  const formatHint = !page
    ? tr('selectFrame')
    : options.paperFormat === 'auto'
      ? detected
        ? `${tr('detected')}: ${detected} · ${formatMm(page.wMm, page.hMm)}${page.fromTrim ? ' (Trimbox)' : ''}${mixed.size > 1 ? ` · ${tr('mixed')} (${[...mixed].join(', ')})` : ''}`
        : `${tr('notIso')} · ${formatMm(page.wMm, page.hMm)}${page.fromTrim ? ' (Trimbox)' : ''} ${tr('pickOrCustom')}`
      : options.paperFormat === 'custom'
        ? `${tr('custom')} · ${formatMm(page.wMm, page.hMm)}`
        : activePaper
          ? detected && detected !== activePaper.id
            ? `${tr('manualPaper')} ${activePaper.id}, ${tr('inFigma')} ${detected} ${formatMm(page.wMm, page.hMm)} ${tr('artboardStays')}`
            : `${tr('manualPaper')} ${activePaper.id} · ${formatMm(activePaper.w, activePaper.h)}`
          : '';
  const append = (...lines: string[]) => setLog((l) => [...l, ...lines]);
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const setOption = (patch: Partial<BuildOptions>) => setSettings((s) => ({ ...s, options: { ...s.options, ...patch } }));

  function effective(hex: string) {
    const o = overrides[hex] ?? {};
    const auto = autos[hex];
    return {
      cmyk: o.cmyk ?? (auto ? autoCmyk(auto, neutralsToK, autoMethod) : ([0, 0, 0, 100] as CMYK)),
      spot: o.spot ?? false,
      name: o.name?.trim() || undefined,
      manual: !!o.cmyk,
    };
  }

  function setOverride(hex: string, patch: ColorOverride | null) {
    setSettings((s) => {
      const next = { ...s.overrides };
      if (patch === null) delete next[hex];
      else next[hex] = { ...next[hex], ...patch };
      return { ...s, overrides: next };
    });
  }

  useEffect(() => {
    const ping = async () => {
      try {
        const res = await fetch(`${SERVER}/ping`);
        if (!res.ok) {
          setOnline(false);
          return;
        }
        const data = (await res.json()) as { ok?: boolean; token?: string };
        if (data.token) sessionToken = data.token;
        setOnline(!!data.ok);
      } catch {
        setOnline(false);
      }
    };
    ping();
    const id = setInterval(ping, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    window.onmessage = async (e: MessageEvent<{ pluginMessage?: PluginMessage }>) => {
      const msg = e.data.pluginMessage;
      if (!msg) return;
      if (msg.type === 'selection') setSelection(msg);
      else if (msg.type === 'settings') {
        const s = msg.settings ?? {};
        setSettings({ ...DEFAULTS, ...s, options: { ...DEFAULTS.options, ...s.options }, locale: s.locale === 'sr' ? 'sr' : s.locale === 'en' ? 'en' : DEFAULTS.locale });
        setLoaded(true);
      } else if (msg.type === 'error') {
        append(`${t(settingsRef.current.locale, 'error')}: ${msg.message}`);
        setBusy(false);
      } else if (msg.type === 'payload') {
        await afterExportRef.current(msg.doc, msg.assets);
        setBusy(false);
      }
    };
    post({ type: 'ready' });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => post({ type: 'save-settings', settings }), 400);
    return () => clearTimeout(id);
  }, [settings, loaded]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  useEffect(() => {
    if (options.paperFormat !== 'auto' || !page) return;
    const next = recommendPpi(page.wMm, page.hMm).ppi;
    if (next !== options.ppi) setOption({ ppi: next });
  }, [page?.wMm, page?.hMm, options.paperFormat]);

  useEffect(() => {
    if (!pending || !online) return;
    const missing = colors.map((c) => ({ cmyk: effective(c.hex).cmyk, hex: c.hex })).filter((r) => !(proofKey(r.cmyk, r.hex) in proofs));
    if (!missing.length) return;
    const id = setTimeout(async () => {
      try {
        const res = await api<ConvertResult>('/convert', { proof: missing });
        setProofs((p) => {
          const next = { ...p };
          missing.forEach((r, i) => {
            if (res.proof?.[i]) next[proofKey(r.cmyk, r.hex)] = res.proof[i];
          });
          return next;
        });
      } catch (e) {
        append(`${tr('proofError')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [pending, colors, overrides, neutralsToK, autoMethod, autos, proofs, online]);

  async function afterExport(doc: IRDocument, assets: Asset[]) {
    setPending({ doc, assets });
    setColors(collectColors(doc));
    setAutos({});
    setProofs({});
    if (doc.options.colorMode === 'CMYK') await prepareColors(doc, assets);
    else append(`${doc.artboards.length} artboard(s).`);
    if (!onlineRef.current) append(tr('offlineHint'));
  }
  afterExportRef.current = afterExport;

  async function prepareColors(doc: IRDocument, assets: Asset[]) {
    const used = collectColors(doc);
    setColors(used);
    setPending({ doc, assets });
    if (!onlineRef.current) {
      append(`${used.length} ${tr('colorsReady')}`);
      return;
    }
    try {
      const res = await api<ConvertResult>('/convert', { rgb: used.map((c) => c.hex) });
      setAutos(Object.fromEntries((res.rgb ?? []).map((a) => [a.hex, a])));
      append(`${used.length} ${tr('colorsReady')}`);
    } catch (e) {
      append(`${tr('convertError')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function send(doc: IRDocument, assets: Asset[]) {
    if (!onlineRef.current) {
      append(tr('sendNeedsPanel'));
      return;
    }
    try {
      const notes = await fitAssetsToPpi(doc, assets, doc.options.ppi ?? 300);
      for (const [i, asset] of assets.entries()) {
        const note = notes.find((n) => n.ref === asset.ref);
        append(`${tr('image')} ${i + 1}/${assets.length}: ${note ? resizeLine(note) : `${(asset.bytes.length / 1e6).toFixed(1)} MB`}`);
        const res = await fetch(`${SERVER}/asset/${asset.ref}`, {
          method: 'POST',
          headers: { 'X-Manifest-Token': sessionToken },
          body: new Blob([asset.bytes as Uint8Array<ArrayBuffer>]),
        });
        if (!res.ok) throw new Error(`upload ${asset.ref}: ${res.status}`);
      }
      append(tr('building'));
      const result = await api<BuildResult>('/build', doc);
      const warnings = [...doc.warnings, ...(result.warnings ?? [])];
      append(`${tr('done')}: ${result.created} ${tr('objects')}`, ...warnings.map((w) => `⚠ ${w}`));
    } catch (e) {
      append(`${tr('error')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function exportSelection() {
    setBusy(true);
    setLog([`${tr('exporting')} ${selection.count} ${tr('frames')}`]);
    post({ type: 'export', options: settingsRef.current.options });
  }

  async function sendWithColors() {
    if (!pending) return;
    setBusy(true);
    const doc = pending.doc.options.colorMode === 'CMYK' ? applyColors(pending.doc, effective) : pending.doc;
    await send(doc, pending.assets);
    setBusy(false);
  }

  async function saveF2a() {
    if (!pending) return;
    setBusy(true);
    try {
      const doc = pending.doc.options.colorMode === 'CMYK' ? applyColors(pending.doc, effective) : pending.doc;
      const files = [
        { name: 'document.json', data: new TextEncoder().encode(JSON.stringify(doc)) },
        ...pending.assets.map((asset) => ({ name: `assets/${asset.ref}`, data: asset.bytes })),
      ];
      const zip = zipStore(files);
      const base = (doc.source.fileName || 'export').replace(/[\\/:*?"<>|]+/g, '-');
      downloadBytes(`${base}.manifest`, zip);
      append(`${tr('saved')} ${base}.manifest`);
    } catch (e) {
      append(`${tr('saveFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  }

  function setInk(hex: string, index: number, raw: string) {
    const cmyk = [...effective(hex).cmyk] as CMYK;
    const v = Number(raw);
    cmyk[index] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : 0;
    setOverride(hex, { cmyk });
  }

  const status = (
    <div className="top">
      <div className={`status ${online ? 'on' : 'off'}`}>{online ? tr('online') : tr('offline')}</div>
      <label className="lang">
        <span className="muted">{tr('lang')}</span>
        <select value={locale} onChange={(e) => update({ locale: e.target.value as Locale })}>
          <option value="en">EN</option>
          <option value="sr">SR</option>
        </select>
      </label>
    </div>
  );
  const credit = <div className="credit muted">Manifest by davidflow</div>;
  const logView = (
    <div className="log" ref={logRef}>
      {log.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
  const actions = (
    <div className="row">
      {pending && (
        <button className="secondary" disabled={busy} onClick={() => setPending(null)}>
          {tr('back')}
        </button>
      )}
      <button className="secondary" disabled={busy || !pending} onClick={saveF2a}>
        {busy ? tr('saving') : tr('saveF2a')}
      </button>
      <button className="grow" disabled={!online || busy || !pending} onClick={sendWithColors}>
        {busy ? tr('sending') : tr('sendAi')}
      </button>
    </div>
  );

  if (pending) {
    const showColors = pending.doc.options.colorMode === 'CMYK' && colors.length > 0;
    return (
      <div className="app">
        {status}
        {showColors && (
          <>
            <label>
              {tr('autoCmyk')}
              <select value={autoMethod} onChange={(e) => update({ autoMethod: e.target.value as AutoMethod })}>
                <option value="closest">{tr('closest')}</option>
                <option value="icc">{tr('icc')}</option>
              </select>
            </label>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={neutralsToK} onChange={(e) => update({ neutralsToK: e.target.checked })} />
                {tr('neutralsToK')}
              </label>
              <button
                className="secondary"
                onClick={() => {
                  const next = { ...overrides };
                  colors.forEach((c) => delete next[c.hex]);
                  update({ overrides: next });
                }}
              >
                {tr('allAuto')}
              </button>
            </div>
            <div className="colors">
              {colors.map((c) => {
                const eff = effective(c.hex);
                const proof = proofs[proofKey(eff.cmyk, c.hex)];
                return (
                  <div className="color" key={c.hex}>
                    <div className="swatches" title={tr('figmaToProof')}>
                      <span className="chip" style={{ background: c.hex }} />
                      <span className="arrow">→</span>
                      <span className="chip" style={{ background: proof?.proof ?? 'transparent' }} />
                    </div>
                    <div className="info">
                      <div className="hex">
                        {c.hex} <span className="muted">×{c.count}</span>{' '}
                        {proof && (
                          <span
                            className={proof.de > VISIBLE_DE ? 'warn' : 'muted'}
                            title={proof.de > VISIBLE_DE ? tr('outOfGamut') : tr('deltaHint')}
                          >
                            {proof.de > VISIBLE_DE ? '⚠ ' : ''}ΔE {proof.de.toFixed(1)}
                          </span>
                        )}
                      </div>
                      <input
                        className="name"
                        placeholder={c.names[0] ?? c.hex}
                        value={overrides[c.hex]?.name ?? ''}
                        onChange={(e) => setOverride(c.hex, { name: e.target.value })}
                      />
                    </div>
                    <div className="inks">
                      {eff.cmyk.map((v, i) => (
                        <label key={i} className={`ink ${eff.manual ? 'manual' : ''}`}>
                          <span>{INKS[i]}</span>
                          <input type="number" min={0} max={100} step={1} value={v} onChange={(e) => setInk(c.hex, i, e.target.value)} />
                        </label>
                      ))}
                    </div>
                    <div className="tools">
                      <label className="check" title={tr('spotTitle')}>
                        <input type="checkbox" checked={eff.spot} onChange={(e) => setOverride(c.hex, { spot: e.target.checked })} />
                        {tr('spot')}
                      </label>
                      <button className="icon" disabled={!overrides[c.hex]} title={tr('resetAuto')} onClick={() => setOverride(c.hex, null)}>
                        ↺
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {actions}
        {logView}
        {credit}
      </div>
    );
  }

  const manualBleed = options.bleedMm !== null;
  return (
    <div className="app">
      {status}

      <label>
        {tr('colorMode')}
        <select value={options.colorMode} onChange={(e) => setOption({ colorMode: e.target.value as BuildOptions['colorMode'] })}>
          <option value="CMYK">{tr('cmykPrint')}</option>
          <option value="RGB">{tr('rgb')}</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={options.trimboxFromSlice} onChange={(e) => setOption({ trimboxFromSlice: e.target.checked })} />
        {tr('trimFromSlice')}
      </label>
      <label>
        {tr('bleed')}
        <span className="row">
          <select value={manualBleed ? 'manual' : 'auto'} onChange={(e) => setOption({ bleedMm: e.target.value === 'manual' ? settings.bleedValue : null })}>
            <option value="auto">{tr('bleedFromFigma')}</option>
            <option value="manual">{tr('bleedManual')}</option>
          </select>
          {manualBleed && (
            <>
              <input
                className="mm"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={options.bleedMm ?? 0}
                onChange={(e) => {
                  const mm = Math.max(0, Number(e.target.value) || 0);
                  setSettings((s) => ({ ...s, bleedValue: mm, options: { ...s.options, bleedMm: mm } }));
                }}
              />
              mm
            </>
          )}
        </span>
      </label>

      <label>
        {tr('format')}
        <select
          value={options.paperFormat}
          onChange={(e) => {
            const paperFormat = e.target.value;
            const p = paperFormat === 'auto' ? paperById(detected ?? '') : paperById(paperFormat);
            const w = p?.w ?? page?.wMm ?? 210;
            const h = p?.h ?? page?.hMm ?? 297;
            setOption({ paperFormat, ppi: recommendPpi(w, h).ppi });
          }}
        >
          <option value="auto">{tr('formatAuto')}</option>
          <option value="custom">{tr('formatCustom')}</option>
          <optgroup label={tr('seriesA')}>
            {PAPERS.filter((p) => p.id.startsWith('A')).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.w} × {p.h} mm
              </option>
            ))}
          </optgroup>
          <optgroup label={tr('seriesB')}>
            {PAPERS.filter((p) => p.id.startsWith('B')).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.w} × {p.h} mm
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="hint">{formatHint}</div>

      <div className="ppi-block">
        <div className="row">
          <span>PPI</span>
          <div className="ppi">
            {PPI_CHOICES.map((p) => (
              <button
                key={p}
                type="button"
                className={`ppi-btn ${options.ppi === p ? 'on' : ''} ${p === rec.ppi ? 'rec' : ''}`}
                onClick={() => setOption({ ppi: p })}
              >
                {p}
                <small>{ppiLabel(locale, p)}</small>
                {p === rec.ppi && <em>{tr('recommended')}</em>}
              </button>
            ))}
          </div>
        </div>
        <div className="hint">
          {tr(rec.kind === 'large' ? 'ppiLargeReason' : 'ppiCloseReason')} {tr('photosHint')}
          {options.ppi !== rec.ppi && options.ppi === 72 ? ` ${tr('ppi72Warn')}` : ''}
        </div>
      </div>

      <label className="check">
        <input type="checkbox" checked={options.embedImages} onChange={(e) => setOption({ embedImages: e.target.checked })} />
        {tr('embedImages')}
      </label>

      <button disabled={busy || selection.count === 0} onClick={exportSelection}>
        {busy ? tr('preparing') : options.colorMode === 'CMYK' ? `${tr('prepareColors')} (${selection.count})` : `${tr('prepare')} (${selection.count})`}
      </button>
      {logView}
      {credit}
    </div>
  );
}
