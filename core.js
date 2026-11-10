/* COD Paisa Reconciliation — core engine (Stage 1)
   DigiDokaan ki 2 file types ko parhta hai:
   (1) All Orders export  (order + paisa, har parcel ek line)
   (2) Ready For Payment CSV (portal ki list jaisi — ek parcel ki kai lines, Tracking par group hoti hain)
   Browser me bhi chalta hai, Node test me bhi. */
(function (global) {
  'use strict';

  // ---------- CSV parser (quotes, commas, newlines handle karta hai) ----------
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false, i, c;
    text = String(text).replace(/^\uFEFF/, '');
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
        } else { field += c; }
      } else if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] && r[0].trim() !== ''); });
  }

  // Header me duplicate naam (DC, Cheque kai dafa ate hain) — occurrence ke hisaab se index
  function headerIndex(header) {
    var occ = {};
    header.forEach(function (h, i) {
      h = String(h).trim();
      if (!occ[h]) occ[h] = [];
      occ[h].push(i);
    });
    return function (name, o) {
      var list = occ[name];
      if (!list) return -1;
      return list[o || 0] !== undefined ? list[o || 0] : -1;
    };
  }

  function num(v) {
    var n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/,/g, '').trim());
    return isNaN(n) ? 0 : n;
  }
  function str(r, i) { return i < 0 ? '' : String(r[i] === undefined ? '' : r[i]).trim(); }

  // ---------- Format pehchan ----------
  function detectFormat(header) {
    var names = header.map(function (h) { return String(h).trim(); });
    if (names.indexOf('Digi Status') >= 0 && names.indexOf('Amount Paid') >= 0) return 'all-orders';
    if (names.indexOf('Upfront') >= 0 && names.indexOf('Net') >= 0 && names.indexOf('Tracking') >= 0) return 'ready-for-payment';
    return 'unknown';
  }

  // ---------- (1) All Orders -> parcels ----------
  function fromAllOrders(rows) {
    var idx = headerIndex(rows[0]);
    var g = function (n, o) { return idx(n, o); };
    var I = {
      date: g('Date'), order: g('Order'), tracking: g('Tracking'), status: g('Digi Status'),
      deliveredDate: g('Delivered Date'), amount: g('Amount'), dc: g('DC', 0), oc: g('OC', 0),
      insCharges: g('Insurance Charges'), returnCharge: g('Return'), pc: g('PC'),
      adjustment: g('Adjustment'), salesTax: g('Sales Tax'), incomeTax: g('Income Tax'),
      paid: g('Amount Paid'), cheque: g('Cheque', 0), weight: g('Merchant Weight')
    };
    return rows.slice(1).map(function (r) {
      var st = str(r, I.status);
      return {
        src: 'all-orders',
        tracking: str(r, I.tracking), order: str(r, I.order), date: str(r, I.date),
        status: st, deliveredDate: str(r, I.deliveredDate),
        delivered: !!str(r, I.deliveredDate) || st === 'Delivered',
        returned: st === 'Returned',
        amount: num(r[I.amount]), dcFile: num(r[I.dc]), ocFile: num(r[I.oc]),
        insFile: num(r[I.insCharges]), returnFile: num(r[I.returnCharge]),
        pcFile: num(r[I.pc]), adjFile: num(r[I.adjustment]),
        stFile: num(r[I.salesTax]), itFile: num(r[I.incomeTax]),
        paid: num(r[I.paid]),
        cheque: str(r, I.cheque),
        otherChargesFile: 0
      };
    }).filter(function (p) { return p.tracking !== ''; });
  }

  // ---------- (2) Ready For Payment -> parcels (Tracking par group) ----------
  function fromReadyForPayment(rows) {
    var idx = headerIndex(rows[0]);
    var I = {
      date: idx('Date'), order: idx('Order'), tracking: idx('Tracking'), status: idx('Status'),
      amount: idx('Amount'), upfront: idx('Upfront'), returnCharge: idx('Return'),
      dc: idx('DC', 0), oc: idx('OC', 0), pc: idx('PC', 0), net: idx('Net')
    };
    var byCn = {};
    rows.slice(1).forEach(function (r) {
      var cn = str(r, I.tracking);
      if (!cn) return;
      if (!byCn[cn]) {
        byCn[cn] = {
          src: 'ready-for-payment',
          tracking: cn, order: str(r, I.order), date: str(r, I.date),
          status: str(r, I.status), deliveredDate: '',
          delivered: /delivered/i.test(str(r, I.status)),
          returned: /return/i.test(str(r, I.status)),
          amount: 0, dcFile: 0, ocFile: 0, insFile: 0, returnFile: 0,
          pcFile: 0, adjFile: 0, stFile: 0, itFile: 0,
          paid: 0, cheque: '', otherChargesFile: 0
        };
      }
      var p = byCn[cn];
      // rakam wali line: Amount bhara hota hai; katauti wali lines usi CN par alag ati hain (DC/PC ke khano me)
      if (num(r[I.amount]) > 0 && p.amount === 0) p.amount = num(r[I.amount]);
      p.paid += num(r[I.net]);
      p.dcFile += Math.abs(num(r[I.dc]));
      p.pcFile += Math.abs(num(r[I.pc]));
      p.ocFile += Math.abs(num(r[I.oc]));
      p.returnFile += Math.abs(num(r[I.returnCharge]));
    });
    return Object.keys(byCn).map(function (k) { return byCn[k]; });
  }

  function parseFile(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { format: 'unknown', parcels: [] };
    var format = detectFormat(rows[0]);
    var parcels = format === 'all-orders' ? fromAllOrders(rows)
      : format === 'ready-for-payment' ? fromReadyForPayment(rows) : [];
    return { format: format, parcels: parcels };
  }

  // ---------- Hisaab engine ----------
  /* rate = { dc: delivery charge per parcel (Rs), stPct: sales tax %, itPct: income tax %, tol: tolerance Rs } */
  function reconcile(parcels, rate) {
    var tol = rate.tol === undefined ? 1 : rate.tol;
    var results = parcels.map(function (p) {
      var r = Object.assign({}, p);
      r.label = ''; r.reason = ''; r.expected = null; r.diff = null;
      var stExp = Math.round(p.amount * rate.stPct) / 100;
      var itExp = Math.round(p.amount * rate.itPct) / 100;
      if (p.delivered) {
        r.expected = p.amount - rate.dc - stExp - itExp;
        r.diff = Math.round((p.paid - r.expected) * 100) / 100;
        if (p.src === 'all-orders' && !p.cheque) {
          r.label = 'KAGAZ-NAHI';
          r.reason = 'Paisa aya (Rs ' + fmt(p.paid) + ') lekin cheque/reference nahi — file me is adaigi ka saboot nahi. Tax kata Rs ' + fmt(p.stFile + p.itFile === 0 ? stExp + itExp : p.stFile + p.itFile) + ' jis ka khana bhi khali hai.';
        } else if (p.dcFile !== 0 && Math.abs(p.dcFile - rate.dc) > tol) {
          r.label = 'ENTRY-FARAQ';
          r.reason = 'File me delivery charge Rs ' + fmt(p.dcFile) + ' likha hai, rate Rs ' + fmt(rate.dc) + ' hai. Paid Rs ' + fmt(p.paid) + ' aya.';
        } else if (p.pcFile !== 0 || p.ocFile !== 0 || p.insFile !== 0 || p.adjFile !== 0) {
          r.label = 'AJEEB-CHARGE';
          r.reason = 'Ghair-mamooli charge darj hai (PC Rs ' + fmt(p.pcFile) + ', OC Rs ' + fmt(p.ocFile) + ', Insurance Rs ' + fmt(p.insFile) + ', Adjustment Rs ' + fmt(p.adjFile) + ') — check karein ye kis cheez ka hai.';
        } else if (r.diff < -tol) {
          r.label = 'KAM-AYA';
          r.reason = 'Ana tha Rs ' + fmt(r.expected) + ', aya Rs ' + fmt(p.paid) + ' — Rs ' + fmt(-r.diff) + ' kam.';
        } else if (r.diff > tol) {
          r.label = 'ZYADA-AYA';
          r.reason = 'Ana tha Rs ' + fmt(r.expected) + ', aya Rs ' + fmt(p.paid) + ' — Rs ' + fmt(r.diff) + ' zyada (entry check karein).';
        } else {
          r.label = 'SAHI';
          r.reason = 'Hisaab rupee-to-rupee mila, cheque ' + (p.cheque ? 'mojood' : '—') + '.';
        }
      } else if (p.returned) {
        r.label = 'RETURN';
        r.reason = Math.abs(p.paid + rate.dc) <= tol
          ? 'Return par sirf delivery charge Rs ' + fmt(rate.dc) + ' kata — aam usool ke mutabiq.'
          : 'Return par kata Rs ' + fmt(-p.paid) + ' — aam delivery charge (Rs ' + fmt(rate.dc) + ') se faraq hai, check karein.';
      } else {
        r.label = 'PENDING';
        r.reason = 'Us waqt status: ' + (p.status || 'raste me') + ' — final faisla (deliver/return) baqi tha, kata hua minus Rs ' + fmt(-p.paid) + '.';
      }
      return r;
    });

    var d = results.filter(function (r) { return r.delivered; });
    var sum = function (arr, f) { return arr.reduce(function (a, r) { return a + f(r); }, 0); };
    var summary = {
      totalParcels: results.length,
      delivered: d.length,
      returned: results.filter(function (r) { return r.label === 'RETURN'; }).length,
      pending: results.filter(function (r) { return r.label === 'PENDING'; }).length,
      sahi: d.filter(function (r) { return r.label === 'SAHI'; }).length,
      problems: d.filter(function (r) { return ['KAGAZ-NAHI', 'ENTRY-FARAQ', 'AJEEB-CHARGE', 'KAM-AYA'].indexOf(r.label) >= 0; }),
      deliveredCOD: sum(d, function (r) { return r.amount; }),
      expectedTotal: sum(d, function (r) { return r.expected || 0; }),
      paidTotal: sum(d, function (r) { return r.paid; }),
      kamTotal: sum(d.filter(function (r) { return r.label === 'KAM-AYA'; }), function (r) { return -(r.diff || 0); }),
      returnKatTotal: -sum(results.filter(function (r) { return r.label === 'RETURN'; }), function (r) { return r.paid; }),
      pendingMinusTotal: -sum(results.filter(function (r) { return r.label === 'PENDING'; }), function (r) { return r.paid; })
    };
    summary.faraqTotal = Math.round((summary.paidTotal - summary.expectedTotal) * 100) / 100;
    return { results: results, summary: summary };
  }

  function fmt(x) {
    var n = Math.round(x * 100) / 100;
    return (n % 1 === 0 ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      : n.toFixed(2).replace(/\B(?=(\d{3})+(\.\d+)?)/g, ','));
  }

  // ---------- Stage 2: merge (duplicate guard) — taza file purani par jeetti hai ----------
  function mergeParcels(existing, incoming) {
    var map = {}, order = [], added = 0, updated = 0;
    (existing || []).forEach(function (p) { if (!map[p.tracking]) order.push(p.tracking); map[p.tracking] = p; });
    (incoming || []).forEach(function (p) {
      if (map[p.tracking]) { updated++; } else { added++; order.push(p.tracking); }
      map[p.tracking] = p;
    });
    return { merged: order.map(function (k) { return map[k]; }), added: added, updated: updated };
  }

  // ---------- Stage 4: mahine ka khulasa ----------
  var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function monthKey(dateStr) {
    var m = String(dateStr || '').match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
    if (!m) return { key: 'NA', label: 'Tareekh nahi' };
    var mon = MONTHS[m[2].slice(0, 3)] || 0;
    return { key: m[3] + '-' + ('0' + mon).slice(-2), label: m[2].slice(0, 3) + ' ' + m[3] };
  }
  function monthSummary(results) {
    var by = {};
    results.forEach(function (r) {
      var mk = monthKey(r.date);
      if (!by[mk.key]) by[mk.key] = { key: mk.key, label: mk.label, parcels: 0, delivered: 0, returned: 0, pending: 0, cod: 0, expected: 0, paid: 0, problems: 0 };
      var b = by[mk.key];
      b.parcels++;
      if (r.delivered) { b.delivered++; b.cod += r.amount; b.expected += r.expected || 0; b.paid += r.paid; if (['KAGAZ-NAHI', 'ENTRY-FARAQ', 'AJEEB-CHARGE', 'KAM-AYA'].indexOf(r.label) >= 0) b.problems++; }
      else if (r.label === 'RETURN') b.returned++;
      else b.pending++;
    });
    return Object.keys(by).sort().map(function (k) { var b = by[k]; b.faraq = Math.round((b.paid - b.expected) * 100) / 100; return b; });
  }

  // ---------- Stage 5: claim list + haftawar summary ----------
  var PROBLEM_LABELS = ['KAM-AYA', 'KAGAZ-NAHI', 'ENTRY-FARAQ', 'AJEEB-CHARGE'];
  function claimRows(results) {
    return results.filter(function (r) { return r.delivered && PROBLEM_LABELS.indexOf(r.label) >= 0; })
      .map(function (r) {
        return {
          Tracking: r.tracking, Order: r.order, Date: r.date, COD: r.amount,
          AnaTha: r.expected, Aya: r.paid, Faraq: Math.round(((r.paid || 0) - (r.expected || 0)) * 100) / 100,
          Masla: r.label, Wajah: r.reason, Cheque: r.cheque || 'NAHI'
        };
      });
  }
  function toCSV(rows, headers) {
    function esc(v) { v = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [headers.join(',')];
    rows.forEach(function (r) { lines.push(headers.map(function (h) { return esc(r[h]); }).join(',')); });
    return '\uFEFF' + lines.join('\r\n');
  }
  function weeklyText(summary, claimsOpen) {
    return 'COD Paisa Report — is haftay ka hisaab:\n' +
      '• Delivered parcels: ' + summary.delivered + ' (sahi: ' + summary.sahi + ')\n' +
      '• Ana tha: Rs ' + fmt(summary.expectedTotal) + ' · Aya: Rs ' + fmt(summary.paidTotal) + '\n' +
      '• Masla parcels: ' + summary.problems.length + (summary.kamTotal > 0 ? ' · Kam aya kul: Rs ' + fmt(summary.kamTotal) : '') + '\n' +
      '• Returned: ' + summary.returned + ' (un par kata: Rs ' + fmt(summary.returnKatTotal) + ')\n' +
      (claimsOpen > 0 ? '• Claim list tayyar hai: ' + claimsOpen + ' parcels courier ko bhejne ke liye.' : '• Koi khula claim nahi — sab saaf.');
  }

  var api = { parseCSV: parseCSV, detectFormat: detectFormat, parseFile: parseFile, reconcile: reconcile, fmt: fmt, mergeParcels: mergeParcels, monthSummary: monthSummary, claimRows: claimRows, toCSV: toCSV, weeklyText: weeklyText, PROBLEM_LABELS: PROBLEM_LABELS };
  global.CODRecon = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
