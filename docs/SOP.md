# SOP — Figma → Illustrator (1:1, editabilno, spremno za štampu)

Javni naziv: **Manifest by davidflow** (ranije F2A / FigmaToIllustrator)
Referenca: [Battle Axe Overlord](https://battleaxe.co/overlord) (funkcija „Figma → Illustrator“, v2.9.0)

---

## Odluke (11.10.2026)

| Tema | Odluka |
|---|---|
| Korisnici | Javno — Figma Community + potpisan `.zxp` (Win i Mac); nema Adobe Exchange u v1 |
| Okruženje | Windows i macOS, Illustrator 2022+ (CEP / CSXS 9–12), Figma desktop |
| Repo | GitHub + Releases (`Manifest-x.y.z.zxp`); vidi `docs/publish.md` |
| Overlord | Nemamo ga — poređenje samo sa Figma SVG/PDF/paste baseline-om |
| Štampa | Veliki format, vizitkarte/flajeri/posteri, brand materijali |
| Prioritet MVP-a | Boje za štampu + editabilan tekst + fotografije |
| UI | React; engleski podrazumevano, srpski locale |
| Paket menadžer | npm workspaces (pnpm nije instaliran) |

Posledice:
- Krajnji korisnik instalira potpisan `.zxp` (Anastasiy / ZXPInstaller). `PlayerDebugMode` i `npm run install:cep` ostaju samo za development.
- Figma desktop je podržan klijent. Figma web može da blokira `localhost` (Private Network Access).
- Veliki format: Ai artboard je max 5779 mm (Large Canvas 57 790 mm) → PPI hint (1:1); skala 1:10 još nije u UI. Slike se proveravaju na efektivni PPI u finalnoj veličini (za bilborde je prag niži, npr. 100–150 PPI, podesivo).

---

## Pokretanje (dev)

```powershell
npm install
npm run build            # Figma plugin -> packages/figma-plugin/dist
npm run install:cep      # linkuje Illustrator panel + PlayerDebugMode
npm run dev              # watch mode za Figma plugin
```

1. Restartuj Illustrator → `Window > Extensions > Manifest` (servis kreće u pozadini; panel je opcion za log / import).
2. Figma desktop → `Plugins > Development > Import plugin from manifest…` → `packages/figma-plugin/manifest.json`.
3. Selektuj frame-ove → pokreni plugin → „Pošalji u Illustrator“.

Builder (`packages/ai-panel/jsx/builder.jsx`) se učitava iznova pri svakom slanju — izmene ne traže restart Illustratora. Panel debug: `http://localhost:8088` u Chrome-u.

**Test bez Figme:** `powershell -File scripts/ai-test.ps1 fixtures/ir/page-01-lite.json` gradi fixture kroz Illustrator COM i snima PNG u `fixtures/out/`.

## Status

- **M1 (gotovo, 11.10.2026):** transport, artboard-i sa bleed-om iz „Trimbox“ slice-a, raspored artboard-a, clip frame-ova i maski, rect/vector/boolean-kao-path/ellipse, solid fill, fotografije (fill/fit/crop, embed), tekst sa stilom po karakteru i rotacijom/skew-om. Testirano na stranici 1 Celje brošure.
- **M2 boje (gotovo, 11.10.2026):** pre slanja plugin prikazuje sve boje (Figma hex → proof iz Illustratora, CMYK, ΔE2000). Auto CMYK = ICC konverzija Illustratora, pa pretraga najbliže štampljive boje (TAC ≤ 300%) kad ΔE > 1; sive/crna opciono samo na K. Ručni CMYK, ime swatch-a i spot po hex-u se pamte u `figma.clientStorage`. U Ai postaju globalni (ili spot) swatch-evi. `/convert` prosleđuje i `proof` payload.
- **M6 (delimično):** linear/radial fill; inside/outside stroke (dupla debljina + clip). Angular/diamond i live Pathfinder još nisu. Efekti (shadow/blur) se i dalje preskaču.
- **Publish (11.10.2026):** Save/Import `.manifest`, session token, EN/SR UI, invisible CEP service, `npm run pack:zxp`. Vidi `docs/publish.md` i `docs/roadmap.md`.
- **Bleed:** auto (iz Trimbox-a) ili ručno u mm. `DocumentPreset.documentBleedOffsetRect` Ai ignoriše (proveren bag) → `jsx/bleed.jsx` snima prazan dokument kao nekompresovan .ai, upiše `Bleed*Value` (uz ispravku PDF `/Length` i xref ofseta) i otvori ga kao .ait šablon.
- ExtendScript zamka: ugnježdeni ternarni operator (`a ? b : c ? d : e`) se pogrešno parsira — koristiti if/else.
- ExtendScript zamka: `TextFont` objekti zastare dok Ai učitava fontove (PARM greška) — font uzimati sveže preko `app.textFonts.getByName()`.
- **Fade maske (11.10.2026):** Figma ALPHA maska sa gradientom (npr. bela 100% → 0%) postaje živi CMYK gradient overlay u boji pozadine (`GradientStop.opacity`). Slika ostaje zamenljiva. VECTOR maska + jedna solid boja (QR tačke) se pojednostavi u tu geometriju, bez clip-a.

---

## 0. Pravila igre (pročitati pre svega)

Cilj je da napravimo **sopstveni alat koji radi isto što i Overlord**, a ne da kopiramo njihov kod.

**Dozvoljeno („clean-room“ pristup):**
- Analiza javnih informacija (sajt, dokumentacija, YouTube tutorijali, changelog, Discord).
- Black-box testiranje: kupljena/trial verzija, šaljemo test fajlove i poredimo **rezultat** u Illustratoru (struktura slojeva, tekst, gradijenti, swatch-evi).
- Čitanje open-source koda AEUX-a (njihov prethodnik, Figma → After Effects) uz poštovanje njegove licence — proveriti `LICENSE` u repou pre preuzimanja bilo čega.
- Čitanje Figma Plugin API i Illustrator scripting dokumentacije.

**Nije dozvoljeno:**
- Dekompajliranje / raspakivanje Overlord aplikacije, Figma plugina ili CEP ekstenzije i preuzimanje njihovog koda.
- Zaobilaženje licenciranja, presretanje i reprodukcija njihovog protokola radi korišćenja bez licence.
- Korišćenje imena „Overlord“ ili njihovih asseta.

Sve što saznamo iz black-box testova beležimo u `docs/research/` kao opis **ponašanja**, ne implementacije.

---

## 1. Šta znamo o Overlordu (javno)

| Činjenica | Izvor | Šta znači za nas |
|---|---|---|
| Desktop app u **Tauri + Svelte** | FAQ na sajtu | Postoji lokalni „hub“ između aplikacija |
| Adobe deo je **Bolt CEP** (Hyper Brew) | FAQ | CEP panel + ExtendScript gradi slojeve u Ai |
| Figma plugin je **Bolt Figma** | FAQ | Plugin + UI iframe, šalje podatke lokalno |
| Sve radi lokalno, offline | FAQ „Is my art private?“ | Transport je `localhost` (HTTP/WebSocket) |
| Figma web i desktop oba rade | sajt | Iz browsera se gađa `localhost` → CORS/PNA pitanje |
| Tekst editabilan sa per-character stilom | sajt | Koriste `getStyledTextSegments` ili ekvivalent |
| Freeform/mesh gradijenti → rasterizacija | sajt | Isto pravilo za Figma angular/diamond |

**Naša pojednostavljena arhitektura:** desktop app nam nije potreban za v1. CEP panel u Illustratoru može da pokrene Node.js server, pa Figma plugin priča direktno sa Illustratorom.

```
┌──────────── Figma ────────────┐        ┌──────────── Illustrator ────────────┐
│ main thread (code.ts)         │        │ CEP panel (Node.js + UI)            │
│  └ čita node tree → JSON      │        │  └ HTTP/WS server na localhost:7531 │
│ UI iframe (ui.svelte/react)   │ ─HTTP→ │  └ zapisuje payload u temp fajl     │
│  └ fetch('http://localhost…') │        │  └ evalScript → ExtendScript builder│
└───────────────────────────────┘        │       └ gradi dokument 1:1          │
                                         └─────────────────────────────────────┘
```

---

## 2. Faza 1 — Istraživanje (1 nedelja)

1. **Baseline bez plugina** — za svaki test fajl (vidi 2.3) uradi:
   - Figma → Export SVG → otvori u Ai
   - Figma → Export PDF → otvori u Ai
   - Copy/Paste iz Figme u Ai
   Zabeleži šta puca. To je lista problema koje moramo da rešimo bolje (tipično: tekst razbijen po linijama, izgubljeni fontovi, gradijenti kao slike, nazivi slojeva nestaju, maske u ugnježdenim grupama, efekti rasterizovani).
2. **Black-box test Overlorda** (trial ili licenca) — isti fajlovi, ista tabela. Fotografiši Layers panel, Appearance panel, Swatches.
3. **Test fajlovi** (`fixtures/figma/`) — jedna Figma stranica po temi:
   - Oblici: rect (uniformni i per-corner radius), ellipse (sa arc/ratio), polygon, star, line, vector sa krivama
   - Boolean: union, subtract, intersect, exclude, ugnježdeni
   - Fill: solid, opacity, više fill-ova, linear/radial/angular/diamond gradijent, image fill (fill/fit/crop/tile)
   - Stroke: inside/center/outside, dash, cap, join, per-side stroke, više stroke-ova
   - Tekst: mešani fontovi/težine/boje u jednom bloku, letter spacing, line height (px/%/auto), paragraph spacing, liste, uppercase, underline, fixed/auto-width/auto-height
   - Efekti: drop shadow, inner shadow, layer blur, background blur
   - Struktura: frame sa clip content, auto layout, komponente i instance, maske, rotacija, flip, blend mode
   - Štampa: frame u mm (A4, vizitkarta 85×55 + 3 mm bleed), slike niske rezolucije

**Izlaz faze:** `docs/research/baseline.md` sa tabelom „funkcija × metoda × rezultat“.

---

## 3. Faza 2 — Setup projekta

```
FigmaToIllustrator/
├─ docs/                 SOP, research, mapping
├─ packages/
│  ├─ schema/            TypeScript tipovi zajedničkog JSON formata (F2A-IR)
│  ├─ figma-plugin/      Bolt Figma (code.ts + UI)
│  └─ ai-panel/          Bolt CEP (Node server + ExtendScript builder)
└─ fixtures/             test fajlovi + očekivani rezultati
```

- Monorepo (pnpm workspaces), TypeScript svuda.
- `schema` paket je jedini ugovor između Figme i Illustratora — obe strane ga importuju.
- Bolt CEP: uključiti Node (`--enable-nodejs`), target Illustrator 2022+.
- ExtendScript nema `JSON` — Bolt CEP to rešava; inače dodati `json2.js` polyfill.

---

## 4. Faza 3 — Međuformat (F2A-IR)

Figma plugin ne zna ništa o Illustratoru, builder ne zna ništa o Figmi. Između je naš JSON.

Pravila:
- Sve koordinate su **apsolutne** (iz `absoluteTransform`), u jedinici `pt` (1 Figma px = 1 pt).
- Svaki čvor ima `transform: [a, b, c, d, tx, ty]` — rotacija/flip se ne „peče“ u geometriju dok nije neophodno.
- Geometrija je uvek **kubni Bezier** (Q krive se konvertuju u C na Figma strani).
- Auto layout se ne prenosi — šaljemo izračunate pozicije.
- Slike idu kao zasebni fajlovi (hash → PNG/JPG), JSON ih samo referencira.

```ts
type IRNode = {
  id: string; name: string; type: 'group' | 'path' | 'compound' | 'text' | 'image' | 'artboard' | 'clip';
  transform: [number, number, number, number, number, number];
  opacity: number; blendMode: BlendMode; visible: boolean; locked: boolean;
  fills?: Paint[]; strokes?: Stroke[]; effects?: Effect[];
  geometry?: { d: string; windingRule: 'nonzero' | 'evenodd' }[];  // path / compound
  shape?: { kind: 'rect' | 'ellipse'; w: number; h: number; radii?: [number, number, number, number] };
  text?: { content: string; frame: 'point' | 'area'; w?: number; h?: number; runs: TextRun[]; paragraphs: Paragraph[] };
  image?: { ref: string; scaleMode: 'fill' | 'fit' | 'crop' | 'tile'; imageTransform?: number[] };
  children?: IRNode[];
};
```

Puna definicija živi u `packages/schema` i verzioniše se (`irVersion`).

---

## 5. Faza 4 — Figma plugin (eksport)

1. Korisnik selektuje frame-ove (ili cela stranica).
2. Rekurzivno prođi kroz čvorove i mapiraj u IR:
   - `RECTANGLE` / `ELLIPSE` → `shape` (da Ai napravi pravi pravougaonik/elipsu), fallback na `fillGeometry`.
   - `VECTOR`, `STAR`, `POLYGON`, `LINE` → `vectorPaths` (ili `fillGeometry` + `strokeGeometry`).
   - `BOOLEAN_OPERATION` → deca + operacija (builder pravi Live Pathfinder ili compound).
   - `TEXT` → `getStyledTextSegments([...])` za runs (font, size, fill, letterSpacing, lineHeight, textCase, textDecoration).
   - `FRAME` / `COMPONENT` / `INSTANCE` → `group` (+ `clip` ako je `clipsContent`); top-level frame → `artboard`.
   - Image fill → `figma.getImageByHash(hash).getBytesAsync()` (originalna rezolucija, bitno za štampu).
3. Šalji iz UI iframe-a (main thread nema mrežu):
   - `manifest.json`: `networkAccess.devAllowedDomains: ["http://localhost:7531"]`, za objavu `allowedDomains` + `reasoning`.
   - Veliki payload: prvo slike (`POST /asset/:hash`), pa JSON (`POST /build`).
4. Fallback ako server nije dostupan: „Save .manifest“ (zip `document.json` + `assets/`) i **Import .manifest** u panelu.

---

## 6. Faza 5 — Illustrator panel (import / builder)

**Node server u CEP panelu**
- `localhost:7531`, CORS `Access-Control-Allow-Origin: *` (Figma iframe ima `null` origin).
- Za Figma web u Chrome-u dodati `Access-Control-Allow-Private-Network: true` na preflight.
- Payload se piše u temp folder; ExtendScript dobija samo putanju (ne slati MB stringova kroz `evalScript`).
- `com.davidflow.manifest.service` je nevidljiva ekstenzija (`StartOn: applicationActivate`) — HTTP server živi i kad panel nije otvoren. Vidljivi panel služi za log i Import .manifest. POST zahteva `X-Manifest-Token` iz `GET /ping`.

**ExtendScript builder — mapiranje**

| Figma | Illustrator | Napomena |
|---|---|---|
| Top-level frame | Artboard + Layer | ime frame-a = ime artboarda |
| Frame sa clip | Group + clipping path | `clipped = true` na grupi |
| Rect (uniform radius) | `pathItems.roundedRectangle` | per-corner radius → ručno građen path |
| Ellipse | `pathItems.ellipse` | arc/ratio → path iz geometrije |
| Vector | `pathItems.add()` + `pathPoints` | anchor + left/right direction iz kubnih kontrola |
| Boolean | compound path ili Live Pathfinder (`executeMenuCommand`) | ostaje editabilno |
| Solid fill | `RGBColor` / `CMYKColor` | vidi Faza 6 |
| Linear/radial gradient | `Gradient` + `GradientColor` + matrica | najteži deo matematike |
| Angular/diamond gradient | rasterizacija (kao Overlord) | opcija u UI |
| Image fill | `placedItems` / `rasterItems` + clip | `embed()` za štampu |
| Stroke center | `strokeWidth`, `strokeDashes`, `strokeCap`, `strokeJoin` | |
| Stroke inside/outside | Offset Path / outline + compound | DOM nema direktno svojstvo — istražiti |
| Više fill/stroke | Appearance (graphic style) ili duplirani path | istražiti u fazi 1 |
| Tekst | `textFrames.pointText` / `areaText` | runs → `characters[i..j].characterAttributes` |
| Letter spacing | `tracking` (1/1000 em) | `px / fontSize * 1000` |
| Line height | `leading` (+ `autoLeading = false`) | % → pt preko fontSize |
| Font | `app.textFonts` (family + style) | mapa za nedostajuće fontove, upozorenje u UI |
| Drop shadow / blur | `applyEffect(LiveEffectXML)` | ostaje živi efekat |
| Background blur | nema ekvivalent | rasterizacija ili preskoči + upozorenje |
| Opacity / blend | `opacity`, `blendingMode` | |
| Komponente | Group (v1), Symbol (v2) | |

**Koordinate:** `app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM`; Figma Y raste nadole, Ai Y nagore → `y_ai = -y_figma`.

**Performanse:** jedan `evalScript` po buildu, sve slike prvo pa geometrija, bez `app.redraw()` u petlji.

---

## 7. Faza 6 — Spremno za štampu

Opcije u UI panela (podrazumevane vrednosti u zagradi):

- **Color mode dokumenta:** CMYK / RGB (CMYK). Konverzija ide kroz Illustratorov Color Settings (ICC profil korisnika, npr. FOGRA39 / ISO Coated v2).
- **Bleed:** 0 / 3 mm / custom (3 mm). Postavlja se na dokument.
- **Spot boje:** Figma style ili variable čije ime počinje sa `PANTONE` ili `Spot/` → spot swatch u Ai.
- **Swatch-evi:** Figma color styles / variables → Ai swatch grupe sa istim imenima.
- **Rich black zaštita:** tekst `#000000` → 100K (ne 4-color black).
- **Provera slika:** upozorenje ako je efektivni PPI < 300 na finalnoj veličini.
- **Fontovi:** lista nedostajućih fontova pre builda; opcija „Create Outlines“ kao zasebni sloj-kopija.
- **Overprint:** opcija za crni tekst.
- **Imena slojeva:** 1:1 iz Figme.

---

## 8. Faza 7 — Testiranje i QA

1. **Vizuelni diff:** Figma `exportAsync` PNG @2x vs Ai export PNG @2x istog artboarda → `pixelmatch`, prag npr. < 0.5 % razlike.
2. **Strukturni test:** za svaki fixture postoji očekivani opis (broj slojeva, tipovi, tekst je `TextFrame`, gradijent nije raster).
3. **Edit test (ručno):** u Ai promeni tekst, boju, gradijent, radius — sve mora da radi bez „Expand“.
4. **Preflight test:** Acrobat Preflight / Output Preview na PDF/X-4 exportu.
5. Regresija: svaki prijavljeni bug dobija novi fixture.

---

## 9. Faza 8 — Distribucija

- Figma: Community (besplatan plugin) — `allowedDomains: ["http://localhost:7531"]` + `reasoning`. Copy: `docs/community-listing.md`.
- Illustrator: potpisan `.zxp` (`npm run pack:zxp` + `ZXPSignCmd`), instalacija preko Anastasiy / ZXPInstaller. Ne Adobe Exchange u v1.
- `.manifest` fallback kad panel nije dostupan.
- Kasnije: UXP ili Tauri hub — `docs/roadmap.md`. Ne raditi hub dok CEP još radi.

---

## 10. Redosled rada (MVP → v1)

| Milestone | Sadržaj | Kriterijum gotovosti |
|---|---|---|
| M0 | Research + fixtures | `baseline.md` popunjen (SVG/PDF/paste) |
| M1 | Transport + osnova | Figma frame → Ai artboard sa pravougaonicima, solid fill, tačna pozicija |
| M2 | Boje za štampu | CMYK dokument, swatch-evi iz Figma styles/variables, spot (`PANTONE…`), rich black, bleed, razmera |
| M3 | Tekst | per-character stilovi, point/area, mapiranje fontova, upozorenje za nedostajuće |
| M4 | Fotografije | image fill (fill/fit/crop) u originalnoj rezoluciji, embed, PPI provera |
| M5 | Geometrija | ellipse, vector, boolean, strokes, grupe, clip, opacity, blend, transformacije |
| M6 | Gradijenti i efekti | linear/radial, shadow, blur, inside/outside stroke, više fill-ova |
| M7 | Polish | performanse, QA diff, GitHub, eventualno ZXP |

---

## 11. Poznati rizici

- **Gradijent matrica** (Figma `gradientTransform` → Ai origin/angle/length/matrix) — rezervisati vreme za matematiku i testove.
- **Stroke align inside/outside** — Ai DOM nema direktno svojstvo; možda kroz Appearance/Offset Path.
- **Više fill-ova** na jednom objektu — scripting pristup Appearance panelu je ograničen.
- **Fontovi** — Figma i Ai imenuju stilove različito („SemiBold“ vs „Semibold“); potrebna fuzzy mapa.
- **Brzina ExtendScript-a** na velikim fajlovima (hiljade slojeva).
- **Figma web → localhost** — browser bezbednosna pravila (Private Network Access) mogu da se menjaju.
