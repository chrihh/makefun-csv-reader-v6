// Fast drop-in for csv-reader 1.0.0, v6 (JavaScript solver): returns
// exactly its answer for every input {text, header} ->
// {columns, rows, errors}. main.ts normally answers through the
// WebAssembly transducer in wasm-bytes.js, which implements this
// same reading; this solver is the entry's own run() and the
// fallback if the transducer cannot start.
//
// Design: three single-direction cursors ride over the text — the
// next quote, the next LF and the next CR at or after the point last
// examined — so each kind of special character is searched for over
// any span of text at most once in the whole run. A record first
// asks the cursors, in O(1), whether its line holds a quote or a
// stray CR at all; if not, the line is taken with one slice and
// split on commas in native code. A quoted field whose closing
// quote sits before the next LF and CR cursors needs no
// transformation and no line counting: its value is the raw slice.
// When line breaks do occur inside quotes and no CR is present,
// they are counted by stepping the LF cursor itself, so that scan
// is shared with everything after it; only a field holding a CR
// pays for a normalising replace, and only a field holding doubled
// quotes pays for the collapsing replace. Unquoted fields end at
// whichever of the comma search and the LF cursor comes first;
// stray CRs are found from the CR cursor, not by a fresh search
// per field.
//
// The reading policy is csv-reader's own, matched case for case:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no
//     characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is
//     not doubled, "" inside it is one quote, and each CRLF or
//     lone CR inside it is read as LF; junk after the closing
//     quote is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character and
//     the rest is re-read unquoted (unterminated_quote);
//   - a quote inside an unquoted field is literal; fields are
//     never trimmed or converted;
//   - columns is the first record when header is true, else null;
//     rows are padded (short_row, with fields) or cut (long_row,
//     with extra) to the first record's width;
//   - errors are {code, line, row} in the order met, line the
//     record's starting line (counting every LF, CRLF and lone CR
//     inside quotes), row its index in rows, null for the header.

const COMMA = 0;
const BREAK = 1;
const END = 2;

const CR_ANY = /\r\n|\r/g;
const PAIR_Q = /""/g;

export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let iQuote = text.indexOf('"', pos);
  let iLF = text.indexOf('\n', pos);
  let iCR = text.indexOf('\r', pos);

  let recordLine = 1;
  let recordRow = null;
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  // Read an unquoted stretch starting at pos, on top of `prefix`.
  function tail(prefix) {
    let parts = null;
    let seg = pos;
    fAdded = 0;
    if (iLF !== -1 && iLF < seg) iLF = text.indexOf('\n', seg);
    for (;;) {
      const iComma = text.indexOf(',', seg);
      let end = n;
      let delim = END;
      if (iLF !== -1) { end = iLF; delim = BREAK; }
      if (iComma !== -1 && iComma < end) { end = iComma; delim = COMMA; }
      if (iCR !== -1 && iCR < seg) iCR = text.indexOf('\r', seg);
      if (iCR !== -1 && iCR < end) {
        if (delim === BREAK && iCR === end - 1) {
          const s = text.slice(seg, iCR);
          fAdded += s.length;
          fVal = parts ? (parts.push(s), parts.join('')) : prefix + s;
          pos = end + 1;
          line += 1;
          fEnd = BREAK;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = prefix ? [prefix] : [];
        const s = text.slice(seg, iCR);
        if (s) parts.push(s);
        fAdded += s.length;
        seg = iCR + 1;
        pos = seg;
        iCR = text.indexOf('\r', seg);
        continue;
      }
      const s = text.slice(seg, end);
      fAdded += s.length;
      fVal = parts ? (s && parts.push(s), parts.join('')) : prefix + s;
      if (delim === COMMA) pos = end + 1;
      else if (delim === BREAK) { pos = end + 1; line += 1; }
      else pos = n;
      fEnd = delim;
      return;
    }
  }

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    if (iLF !== -1 && iLF < pos) iLF = text.indexOf('\n', pos);
    if (iQuote !== -1 && iQuote < pos) iQuote = text.indexOf('"', pos);
    if (iCR !== -1 && iCR < pos) iCR = text.indexOf('\r', pos);

    // Whole-line path, decided from the cursors.
    let fields = null;
    {
      const lineStop = iLF === -1 ? n : iLF;
      let sliceStop = -1;
      if (iQuote === -1 || iQuote >= lineStop) {
        if (iCR === -1 || iCR > lineStop) sliceStop = lineStop;
        else if (iLF !== -1 && iCR === lineStop - 1) sliceStop = lineStop - 1;
      }
      if (sliceStop !== -1) {
        const lineText = text.slice(pos, sliceStop);
        pos = iLF === -1 ? n : iLF + 1;
        if (iLF !== -1) line += 1;
        if (lineText !== '') fields = lineText.split(',');
      }
    }

    if (fields === null) {
      fields = [];
      let lastQuoted = false;
      for (;;) {
        if (pos < n && text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          const open = pos;
          const openLine = line;
          let q = text.indexOf('"', open + 1);
          let doubled = false;
          while (q !== -1 && q + 1 < n && text.charCodeAt(q + 1) === 34) {
            doubled = true;
            q = text.indexOf('"', q + 2);
          }
          if (q === -1) {
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            tail('"');
          } else {
            if (iLF !== -1 && iLF < open + 1) iLF = text.indexOf('\n', open + 1);
            if (iCR !== -1 && iCR < open + 1) iCR = text.indexOf('\r', open + 1);
            const hasLF = iLF !== -1 && iLF < q;
            const hasCR = iCR !== -1 && iCR < q;
            let value = text.slice(open + 1, q);
            if (hasCR) {
              value = value.replace(CR_ANY, '\n');
              let breaks = 0;
              let bi = -1;
              while ((bi = value.indexOf('\n', bi + 1)) !== -1) breaks += 1;
              line += breaks;
              if (doubled) value = value.replace(PAIR_Q, '"');
            } else if (hasLF) {
              let breaks = 0;
              while (iLF !== -1 && iLF < q) {
                breaks += 1;
                iLF = text.indexOf('\n', iLF + 1);
              }
              line += breaks;
              if (doubled) value = value.replace(PAIR_Q, '"');
            } else if (doubled) {
              value = value.replace(PAIR_Q, '"');
            }
            pos = q + 1;
            if (pos >= n) {
              fVal = value;
              fEnd = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) { pos += 1; fVal = value; fEnd = COMMA; }
              else if (c === 10) { pos += 1; line += 1; fVal = value; fEnd = BREAK; }
              else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
                pos += 2; line += 1; fVal = value; fEnd = BREAK;
              } else {
                tail(value);
                if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        } else {
          lastQuoted = false;
          if (iLF !== -1 && iLF < pos) iLF = text.indexOf('\n', pos);
          let parts = null;
          let seg = pos;
          const start = pos;
          for (;;) {
            const iComma = text.indexOf(',', seg);
            let end = n;
            let delim = END;
            if (iLF !== -1) { end = iLF; delim = BREAK; }
            if (iComma !== -1 && iComma < end) { end = iComma; delim = COMMA; }
            if (iCR !== -1 && iCR < seg) iCR = text.indexOf('\r', seg);
            if (iCR !== -1 && iCR < end) {
              if (delim === BREAK && iCR === end - 1) {
                const s = text.slice(seg, iCR);
                fVal = parts ? (parts.push(s), parts.join('')) : s;
                pos = end + 1;
                line += 1;
                fEnd = BREAK;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              if (parts === null) parts = [];
              const s = text.slice(seg, iCR);
              if (s) parts.push(s);
              seg = iCR + 1;
              pos = seg;
              iCR = text.indexOf('\r', seg);
              continue;
            }
            fVal = parts
              ? (parts.push(text.slice(seg, end)), parts.join(''))
              : text.slice(start, end);
            if (delim === COMMA) pos = end + 1;
            else if (delim === BREAK) { pos = end + 1; line += 1; }
            else pos = n;
            fEnd = delim;
            break;
          }
        }
        fields.push(fVal);
        if (fEnd !== COMMA) break;
      }
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
