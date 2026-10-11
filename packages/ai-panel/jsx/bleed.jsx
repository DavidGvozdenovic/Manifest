// Document bleed workaround: DocumentPreset.documentBleedOffsetRect is ignored by Illustrator,
// so the bleed is written into a saved, uncompressed .ai and the file is reopened as a template.
// The .ai is a PDF container: edits must fix the enclosing stream /Length and the xref offsets.

var F2ABleed = (function () {
  function pad10(n) {
    var s = String(n);
    while (s.length < 10) s = '0' + s;
    return s;
  }

  function fmt(v) {
    return String(Math.round(v * 10000) / 10000);
  }

  /** Replaces s[start,end) with repl, keeping the PDF structure consistent. */
  function splice(s, start, end, repl) {
    var lenKey = '/Length ';
    var dictStart = s.lastIndexOf('<<', start);
    var lenPos = s.indexOf(lenKey, dictStart);
    var streamPos = s.indexOf('stream', dictStart);
    if (dictStart < 0 || lenPos < 0 || lenPos > streamPos) throw new Error('bleed: stream header not found');
    var digitsStart = lenPos + lenKey.length;
    var digitsEnd = digitsStart;
    while (/[0-9]/.test(s.charAt(digitsEnd))) digitsEnd++;
    var oldLen = parseInt(s.substring(digitsStart, digitsEnd), 10);
    var delta = repl.length - (end - start);
    var newDigits = String(oldLen + delta);

    s = s.substring(0, start) + repl + s.substring(end);
    s = s.substring(0, digitsStart) + newDigits + s.substring(digitsEnd);
    var total = delta + newDigits.length - (digitsEnd - digitsStart);
    if (!total) return s;

    var sx = s.lastIndexOf('startxref');
    var m = /startxref\s+(\d+)/.exec(s.substring(sx));
    if (!m) throw new Error('bleed: startxref not found');
    var xrefPos = parseInt(m[1], 10) + total;
    var trailer = s.indexOf('trailer', xrefPos);
    if (s.substring(xrefPos, xrefPos + 4) !== 'xref' || trailer < 0) throw new Error('bleed: xref not found');
    var table = s.substring(xrefPos, trailer).replace(/(\d{10}) (\d{5}) n/g, function (all, off, gen) {
      var o = parseInt(off, 10);
      return (o > digitsStart ? pad10(o + total) : off) + ' ' + gen + ' n';
    });
    s = s.substring(0, xrefPos) + table + s.substring(trailer);
    sx = s.lastIndexOf('startxref');
    return s.substring(0, sx) + s.substring(sx).replace(/startxref(\s+)\d+/, 'startxref$1' + xrefPos);
  }

  function readBinary(file) {
    file.encoding = 'BINARY';
    file.open('r');
    var s = file.read();
    file.close();
    return s;
  }

  function writeBinary(file, s) {
    file.encoding = 'BINARY';
    file.open('w');
    file.write(s);
    file.close();
  }

  /** Patches bleed values (points) into AI private data; returns the number of values written. */
  function patch(s, bleed) {
    var names = { Left: bleed[0], Top: bleed[1], Right: bleed[2], Bottom: bleed[3] };
    var hits = 0;
    for (var k in names) {
      var re = new RegExp('%_[-0-9.eE]+ /Real \\(Bleed' + k + 'Value\\)', 'g');
      var from = 0, m;
      while (true) {
        re.lastIndex = from;
        m = re.exec(s);
        if (!m) break;
        var repl = '%_' + fmt(names[k]) + ' /Real (Bleed' + k + 'Value)';
        s = splice(s, m.index, m.index + m[0].length, repl);
        from = m.index + repl.length;
        hits++;
      }
    }
    return { text: s, hits: hits };
  }

  /**
   * Returns a new untitled document whose bleed is [left, top, right, bottom] in points,
   * or the original document if patching fails (with the error in result.error).
   */
  function apply(doc, bleed, tempDir) {
    var src = new File(tempDir + '/f2a-bleed-src.ai');
    var tpl = new File(tempDir + '/f2a-bleed.ait');
    var o = new IllustratorSaveOptions();
    o.compressed = false;
    o.pdfCompatible = false;
    doc.saveAs(src, o);
    var r = patch(readBinary(src), bleed);
    if (!r.hits) return { doc: doc, error: 'bleed values not found in file' };
    writeBinary(tpl, r.text);
    var opened;
    try {
      opened = app.open(tpl);
    } catch (e) {
      return { doc: doc, error: e.message };
    }
    doc.close(SaveOptions.DONOTSAVECHANGES);
    src.remove();
    tpl.remove();
    return { doc: opened, error: null };
  }

  return { apply: apply, patch: patch };
})();
