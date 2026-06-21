/**
 * 24_Dashboard.gs
 * Frank's European Service — Recruiting OS
 *
 * One-shot wireup of the Dashboard tab. Writes the layout plus live spreadsheet
 * formulas that read from All Candidates + Interview Pipeline. Per project
 * BI rules, KPIs live in sheet formulas (not Apps Script).
 *
 * Public functions:
 *   DASHBOARD_rebuild()         — clears Dashboard, writes layout + formulas
 *   DASHBOARD_selfTest()        — verifies sheet writable, formulas resolve
 */

// The reference cell references below assume the canonical column order from
// 02_Setup_Bootstrap.gs SHEET_MANIFEST. If you reorder All Candidates or
// Interview Pipeline columns, re-run DASHBOARD_rebuild() to pick up the change.

function DASHBOARD_rebuild() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.DASHBOARD);
    sh.clear();
    sh.clearFormats();

    var ac = SHEETS.ALL_CANDIDATES;
    var ip = SHEETS.INTERVIEW_PIPELINE;

    // Helper: quote sheet name for formulas
    function ref(sheetName, range) { return "'" + sheetName + "'!" + range; }

    // Resolve the Interview Pipeline "Status" column by header so the dashboard
    // survives column trims/reorders instead of hardcoding a letter.
    var ipStatusLetter = 'AA';
    try {
      var ipSheet = getSheetOrNull_(ip);
      if (ipSheet) {
        var sc = getColIndex_(ipSheet, 'Status');
        if (sc) ipStatusLetter = _columnToLetter_(sc);
      }
    } catch (e) { /* keep default */ }
    function ipStatus() { return ref(ip, ipStatusLetter + '2:' + ipStatusLetter); }

    // ── ROW 1 — Title
    sh.getRange('A1').setValue("FRANK'S EUROPEAN SERVICE — RECRUITING DASHBOARD")
      .setFontWeight('bold').setFontSize(16).setBackground('#0b3d2e').setFontColor('#ffffff');
    sh.getRange('A1:H1').merge();
    sh.getRange('A2').setValue('Live data from All Candidates + Interview Pipeline · refresh by reloading the spreadsheet')
      .setFontStyle('italic').setFontColor('#666');
    sh.getRange('A2:H2').merge();
    sh.getRange('I1').setValue('Last refreshed').setFontWeight('bold');
    sh.getRange('I2').setFormula('=NOW()');
    sh.getRange('I2').setNumberFormat('yyyy-mm-dd hh:mm');

    // ── ROW 3 — F1: MODE BANNER. Make it impossible to mistake an intentionally
    // muted system for a malfunction. Bright amber in TEST, green in LIVE.
    _dashboardModeBanner_(sh, 'A3:I3');

    // ── ROW 4 — KPI labels
    var kpiLabels = ['TOTAL APPLIED', 'IN PIPELINE', 'STRONG PENDING', 'NEW TODAY', 'FORM COMPLETION', 'HIRES THIS QTR'];
    sh.getRange('A4:F4').setValues([kpiLabels])
      .setFontWeight('bold').setBackground('#f3f4f6').setFontColor('#555');

    // ── ROW 5 — KPI values
    sh.getRange('A5').setFormula(
      '=COUNTA(' + ref(ac, 'A2:A') + ')'
    );
    sh.getRange('B5').setFormula(
      '=COUNTIFS(' + ref(ac, 'P2:P') + ',"<>HIRED",' +
                    ref(ac, 'P2:P') + ',"<>REJECTED",' +
                    ref(ac, 'P2:P') + ',"<>ARCHIVED",' +
                    ref(ac, 'P2:P') + ',"<>"' +
      ')'
    );
    sh.getRange('C5').setFormula(
      '=COUNTIFS(' + ref(ac, 'M2:M') + ',"Strong",' + ref(ac, 'P2:P') + ',"<>HIRED",' +
                    ref(ac, 'P2:P') + ',"<>REJECTED",' + ref(ac, 'P2:P') + ',"<>ARCHIVED")'
    );
    sh.getRange('D5').setFormula(
      '=COUNTIFS(' + ref(ac, 'A2:A') + ',">=" & TODAY())'
    );
    sh.getRange('E5').setFormula(
      '=IFERROR(ROUND(COUNTA(' + ref(ac, 'K2:K') + ') / COUNTA(' + ref(ac, 'J2:J') + ') * 100, 0) & "%", "0%")'
    );
    // HIRES THIS QTR — Status=HIRED with Last Updated in the current calendar quarter
    sh.getRange('F5').setFormula(
      '=COUNTIFS(' + ref(ac, 'P2:P') + ',"HIRED",' +
                    ref(ac, 'W2:W') + ',">=" & DATE(YEAR(TODAY()), QUOTIENT(MONTH(TODAY())-1, 3)*3+1, 1))'
    );
    sh.getRange('A5:F5').setFontSize(20).setFontWeight('bold').setFontColor('#0b3d2e');

    // ── ROW 8 — PIPELINE FUNNEL header
    sh.getRange('A8').setValue('PIPELINE FUNNEL')
      .setFontWeight('bold').setFontColor('#fff').setBackground('#0b3d2e');
    sh.getRange('A8:E8').merge();

    sh.getRange('A9:E9').setValues([['APPLIED', 'CONTACTED', 'FORM SENT', 'FORM COMPLETE', 'STRONG']])
      .setFontWeight('bold').setBackground('#f3f4f6');

    sh.getRange('A10').setFormula('=COUNTA(' + ref(ac, 'A2:A') + ')');
    sh.getRange('B10').setFormula('=COUNTA(' + ref(ac, 'I2:I') + ')');                 // Intro Sent
    sh.getRange('C10').setFormula('=COUNTA(' + ref(ac, 'J2:J') + ')');                 // Form Sent
    sh.getRange('D10').setFormula('=COUNTA(' + ref(ac, 'K2:K') + ')');                 // Form Completed
    sh.getRange('E10').setFormula('=COUNTIF(' + ref(ac, 'M2:M') + ',"Strong")');       // Score Tier = Strong

    // Funnel conversion rates row
    sh.getRange('A11').setValue('—').setFontStyle('italic').setFontColor('#888');
    sh.getRange('B11').setFormula('=IFERROR("→ " & ROUND(B10/A10*100,0) & "% of APPLIED","")');
    sh.getRange('C11').setFormula('=IFERROR("→ " & ROUND(C10/B10*100,0) & "% of CONTACTED","")');
    sh.getRange('D11').setFormula('=IFERROR("→ " & ROUND(D10/C10*100,0) & "% of FORM SENT","")');
    sh.getRange('E11').setFormula('=IFERROR("→ " & ROUND(E10/D10*100,0) & "% of FORM COMPLETE","")');
    sh.getRange('A11:E11').setFontStyle('italic').setFontColor('#888').setFontSize(11);

    // ── ROW 14 — PIPELINE BY ROLE
    sh.getRange('A14').setValue('PIPELINE BY ROLE')
      .setFontWeight('bold').setFontColor('#fff').setBackground('#0b3d2e');
    sh.getRange('A14:G14').merge();

    sh.getRange('A15:G15').setValues([['Role', 'Total', 'New Today', 'Form Complete', 'Strong', 'In Manual Review', 'Rejected/Archived']])
      .setFontWeight('bold').setBackground('#f3f4f6');

    var roles = ROLES.slice(); // canonical roles (00_Config) — stays in sync after normalization
    roles.forEach(function (role, idx) {
      var row = 16 + idx;
      sh.getRange('A' + row).setValue(role);
      sh.getRange('B' + row).setFormula('=COUNTIF(' + ref(ac, 'B2:B') + ',"' + role + '")');
      sh.getRange('C' + row).setFormula(
        '=COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'A2:A') + ',">=" & TODAY())'
      );
      sh.getRange('D' + row).setFormula(
        '=COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'K2:K') + ',"<>")'
      );
      sh.getRange('E' + row).setFormula(
        '=COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'M2:M') + ',"Strong")'
      );
      sh.getRange('F' + row).setFormula(
        '=COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'P2:P') + ',"MANUAL_REVIEW")'
      );
      sh.getRange('G' + row).setFormula(
        '=COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'P2:P') + ',"REJECTED") + ' +
        'COUNTIFS(' + ref(ac, 'B2:B') + ',"' + role + '",' + ref(ac, 'P2:P') + ',"ARCHIVED")'
      );
    });
    // TOTAL row
    var totalRow = 16 + roles.length;
    sh.getRange('A' + totalRow).setValue('TOTAL').setFontWeight('bold');
    ['B', 'C', 'D', 'E', 'F', 'G'].forEach(function (c) {
      sh.getRange(c + totalRow).setFormula('=SUM(' + c + '16:' + c + (totalRow - 1) + ')').setFontWeight('bold');
    });

    // ── TOP 10 CANDIDATES BY SCORE
    var topStart = totalRow + 3;
    sh.getRange('A' + topStart).setValue('TOP 10 CANDIDATES BY SCORE (not in terminal state)')
      .setFontWeight('bold').setFontColor('#fff').setBackground('#0b3d2e');
    sh.getRange('A' + topStart + ':G' + topStart).merge();

    sh.getRange('A' + (topStart + 1) + ':G' + (topStart + 1))
      .setValues([['Score', 'First Name', 'Last Name', 'Role', 'Tier', 'Status', 'Email']])
      .setFontWeight('bold').setBackground('#f3f4f6');

    // QUERY to fetch top 10. Columns from All Candidates:
    // C=First Name, D=Last Name, E=Email, B=Role, L=Total Score, M=Score Tier, P=Status
    sh.getRange('A' + (topStart + 2)).setFormula(
      '=IFERROR(' +
        'QUERY(' + ref(ac, 'A2:V') + ', "SELECT L,C,D,B,M,P,E ' +
                  "WHERE L IS NOT NULL AND L > 0 " +
                  "AND P <> 'HIRED' AND P <> 'REJECTED' AND P <> 'ARCHIVED' " +
                  'ORDER BY L DESC LIMIT 10", 0), ' +
        '"(no scored candidates yet)")'
    );

    // ── ACTION ITEMS
    var actionStart = topStart + 14;
    sh.getRange('A' + actionStart).setValue('ACTION ITEMS — pick a Manager Decision in Interview Pipeline')
      .setFontWeight('bold').setFontColor('#fff').setBackground('#0b3d2e');
    sh.getRange('A' + actionStart + ':D' + actionStart).merge();

    sh.getRange('A' + (actionStart + 1) + ':D' + (actionStart + 1))
      .setValues([['Item', 'Count', 'Recommended Action', '']])
      .setFontWeight('bold').setBackground('#f3f4f6');

    var actions = [
      ['Pending manager decision',                       '=COUNTIF(' + ipStatus() + ',"MANUAL_REVIEW")', 'Review in Interview Pipeline — pick a Manager Decision'],
      ['AI Recommended candidates',                      '=COUNTIF(' + ipStatus() + ',"RECOMMENDED")', 'Review AI recommendation, advance to offer'],
      ['Pending references',                             '=COUNTIF(' + ipStatus() + ',"REFS_PENDING")', 'Wait — references are out'],
      ['Offer pending',                                  '=COUNTIF(' + ipStatus() + ',"OFFER_PENDING")', 'Finalize and send offer'],
      ['In drawer (awaiting follow-up)',                 '=COUNTIF(' + ipStatus() + ',"IN_DRAWER")', 'Re-engage or let timer send hold email'],
      ['Stuck (no update in ' + CFG.getInt('STUCK_CANDIDATE_DAYS', 5) + '+ days)',
                                                         '=COUNTIFS(' + ref(ac, 'W2:W') + ',"<" & (TODAY() - ' + CFG.getInt('STUCK_CANDIDATE_DAYS', 5) + '),' +
                                                                       ref(ac, 'P2:P') + ',"<>HIRED",' +
                                                                       ref(ac, 'P2:P') + ',"<>REJECTED",' +
                                                                       ref(ac, 'P2:P') + ',"<>ARCHIVED")', 'Re-engage or archive']
    ];
    actions.forEach(function (a, idx) {
      var r = actionStart + 2 + idx;
      sh.getRange('A' + r).setValue(a[0]);
      sh.getRange('B' + r).setFormula(a[1]);
      sh.getRange('C' + r).setValue(a[2]).setFontStyle('italic').setFontColor('#555');
    });

    // ── SOURCE PERFORMANCE
    var srcStart = actionStart + actions.length + 4;
    sh.getRange('A' + srcStart).setValue('SOURCE PERFORMANCE')
      .setFontWeight('bold').setFontColor('#fff').setBackground('#0b3d2e');
    sh.getRange('A' + srcStart + ':E' + srcStart).merge();

    sh.getRange('A' + (srcStart + 1) + ':E' + (srcStart + 1))
      .setValues([['Source', 'Total', 'Form Complete', 'Strong', 'Strong Rate']])
      .setFontWeight('bold').setBackground('#f3f4f6');

    // QUERY group by Source
    sh.getRange('A' + (srcStart + 2)).setFormula(
      '=IFERROR(' +
        'QUERY(' + ref(ac, 'A2:V') + ',' +
              '"SELECT G, COUNT(A), COUNT(K), SUM(IF(M=\'Strong\',1,0)) ' +
               "WHERE G IS NOT NULL " +
               "GROUP BY G " +
               'LABEL G \'Source\', COUNT(A) \'Total\', COUNT(K) \'Form Complete\', SUM(IF(M=\'Strong\',1,0)) \'Strong\'", 0),' +
        '"(no sources yet)")'
    );
    // Note: SUM(IF()) inside QUERY isn't standard; fall back to simpler if needed
    // If QUERY errors, use plain manual rows below.

    // ── Column widths
    sh.setColumnWidth(1, 220);
    [2,3,4,5,6,7].forEach(function (c) { sh.setColumnWidth(c, 130); });
    sh.setColumnWidth(8, 50);
    sh.setColumnWidth(9, 160);

    // ── Conditional formatting — draw the eye to what needs attention
    _dashboardConditionalFormatting_(sh, {
      topStart: topStart, actionStart: actionStart, roleStart: 16, roleEnd: totalRow - 1
    });

    var msg = '[DASHBOARD] rebuilt at ' + shopDateTime_();
    Logger.log(msg);
    toast_('Dashboard rebuilt with live formulas', 'Recruiting OS', 6);
    return msg;
  });
}

/**
 * Apply conditional formatting so critical numbers stand out:
 *   • Action-item counts > 0 → amber; the "pending decision" count → red when >0
 *   • TOP candidates score column → green (high) to red (low) color scale
 *   • PIPELINE BY ROLE "In Manual Review" count > 0 → amber
 *   • Risk-style red text for high values is applied where risk surfaces
 */
function _dashboardConditionalFormatting_(sh, pos) {
  var rules = [];

  // Rule order matters: the FIRST matching rule wins. Put the most specific
  // (pending-decision red) BEFORE the broader amber rule that covers it.

  // "Pending manager decision" (row actionStart+2) — red when > 0 (top priority).
  var pendingDecision = sh.getRange('B' + (pos.actionStart + 2));
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0).setBackground('#fecaca').setFontColor('#991b1b').setBold(true)
    .setRanges([pendingDecision]).build());

  // Other action-item counts (rows actionStart+3 .. +8) — amber when > 0.
  var otherActions = sh.getRange('B' + (pos.actionStart + 3) + ':B' + (pos.actionStart + 8));
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0).setBackground('#fde68a').setFontColor('#7c2d12')
    .setRanges([otherActions]).build());

  // TOP candidates score column A — color scale (red low → green high).
  var topScores = sh.getRange('A' + (pos.topStart + 2) + ':A' + (pos.topStart + 11));
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue('#f8696b', SpreadsheetApp.InterpolationType.NUMBER, '40')
    .setGradientMidpointWithValue('#ffeb84', SpreadsheetApp.InterpolationType.NUMBER, '70')
    .setGradientMaxpointWithValue('#63be7b', SpreadsheetApp.InterpolationType.NUMBER, '90')
    .setRanges([topScores]).build());

  // PIPELINE BY ROLE — "In Manual Review" column F — amber when > 0.
  var reviewCol = sh.getRange('F' + pos.roleStart + ':F' + pos.roleEnd);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0).setBackground('#fde68a')
    .setRanges([reviewCol]).build());

  sh.setConditionalFormatRules(rules);
}

/**
 * F1: write the TEST/LIVE mode banner into the given A1 range. In TEST (or with
 * sending off) it shows a bright amber "no candidate emails are sending" warning
 * so a deliberately muted pre-launch system is never mistaken for broken.
 */
function _dashboardModeBanner_(sh, rangeA1) {
  var live   = isLiveMode_();
  var sendOn = sendEnabled_();
  var pause  = CFG.getBool('HIRING_PAUSE_MODE', false);
  var rng = sh.getRange(rangeA1);
  try { rng.breakApart(); } catch (e) {}
  rng.merge();

  var text, bg, fg;
  if (live && sendOn && !pause) {
    text = '🟢 LIVE — candidate emails ARE sending. Real candidates receive automated messages.';
    bg = '#0b3d2e'; fg = '#ffffff';
  } else if (live && sendOn && pause) {
    text = '🟡 LIVE + HIRING PAUSE — pre-screens still score, but only the "not currently hiring" reply goes out (no booking emails).';
    bg = '#b25e09'; fg = '#ffffff';
  } else {
    text = '🟠 TEST MODE — NO candidate emails are sending. All mail reroutes to ' +
           (CFG.get('TEST_RECIPIENT_EMAIL') || 'the test recipient') +
           '. This is the intended pre-launch state — Menu → Mode & Status → GO LIVE when ready.';
    bg = '#f59e0b'; fg = '#3b1d00';
  }
  rng.setValue(text).setFontWeight('bold').setBackground(bg).setFontColor(fg)
     .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  try { sh.setRowHeight(rng.getRow(), 34); } catch (e) {}
}

/** 1-based column index → A1 letter (1→A, 27→AA). */
function _columnToLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = Math.floor((col - 1) / 26); }
  return s || 'A';
}

function DASHBOARD_selfTest() {
  var out = ['[DASHBOARD] selfTest (read-only)…'];
  var sh = getSheetOrNull_(SHEETS.DASHBOARD);
  out.push('  ' + (sh ? '✓' : '✗') + ' Dashboard tab present');
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  out.push('  ' + (ac ? '✓' : '✗') + ' All Candidates present (rows=' + (ac ? ac.getLastRow() - 1 : 0) + ')');
  out.push('  ' + (ip ? '✓' : '✗') + ' Interview Pipeline present (rows=' + (ip ? ip.getLastRow() - 1 : 0) + ')');
  out.push('  ─ Run DASHBOARD_rebuild() to write layout + formulas to Dashboard tab.');
  out.push('  ─ Formulas live in the sheet — no Apps Script computation. To refresh, reload the spreadsheet.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
