/**
 * 29_Resume_Grading.gs
 * Frank's European Service — Recruiting OS
 *
 * AI-grades a candidate's RESUME against the role, alongside the existing
 * pre-screen AI review. Purpose: weed out unqualified applicants up front.
 *
 * WHERE THE RESUME COMES FROM (Indeed resumes can't be auto-fetched, so the
 * resume must arrive on the pre-screen form):
 *   • A Google Forms "File upload" question -> the response stores a Drive URL
 *     in the candidate's "Resume Link". PDFs/images are read via Drive OCR;
 *     Google Docs / text files are read directly.
 *   • OR the resume pasted into a long-answer field that lands in "Resume Link"
 *     (treated as text when it is long and not a URL).
 * If no readable resume is present, the candidate is marked NO RESUME and the
 * rest of the pipeline is unaffected.
 *
 * Public functions:
 *   gradeResumeForCandidate_(candidateId)  — grade one (called from intake)
 *   backfillResumeGrades()                 — grade everyone missing a grade
 *   RESUME_selfTest()
 *
 * Writes (created automatically if missing): Resume Score, Resume Qualified,
 * Resume Status, Resume Summary — to both All Candidates and Interview Pipeline.
 */

var RESUME_OUTPUT_COLUMNS = ['Resume Score', 'Resume Qualified', 'Resume Status', 'Resume Summary'];

// ─────────────────────────────────────────────────────────────────────────────
// GRADE ONE CANDIDATE
// ─────────────────────────────────────────────────────────────────────────────

function gradeResumeForCandidate_(candidateId) {
  if (!candidateId) return null;
  if (!CFG.getBool('RESUME_AI_GRADING_ENABLED', true)) return null;

  var cand = _getCandidateRow_(candidateId);
  if (!cand) { logError_('gradeResumeForCandidate_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return null; }

  _ensureResumeColumns_();

  var ex = _extractResumeText_(cand);
  if (!ex.text) {
    _writeResumeResult_(candidateId, { 'Resume Status': ex.status || 'NO RESUME' });
    Logger.log('[RESUME] ' + candidateId + ' — no gradeable resume (' + (ex.status || 'NO RESUME') + ')');
    return null;
  }

  var prompt = _loadAiPrompt_('resume_review');
  if (!prompt) {
    logError_('gradeResumeForCandidate_', 'AI prompt "resume_review" not found — run installAllAiPrompts()', candidateId, 'ERROR');
    return null;
  }

  var roleRule = _getRoleRule_(cand['Role']);
  var promptText = renderMerge_(prompt['Prompt Body'], {
    RoleName:         cand['Role'] || 'the role',
    RoleRequirements: (roleRule && roleRule['Notes']) || '(see Role Rules)',
    ResumeText:       truncate_(ex.text, 12000),
    Provider:         CFG.get('AI_PROVIDER', 'gemini'),
    Model:            CFG.get('GEMINI_MODEL')
  });

  var r = _geminiGradeJson_('resume_review', candidateId, promptText);
  if (!r.ok || !r.data) {
    _writeResumeResult_(candidateId, { 'Resume Status': 'AI FAILED' });
    logError_('gradeResumeForCandidate_:ai', r.error || 'unknown', candidateId, 'WARN');
    return null;
  }

  var d = r.data;
  var score = Number(d.resume_score);
  if (isNaN(score)) score = '';
  var minScore = CFG.getInt('RESUME_MIN_SCORE', 50);
  var qualified = (d.qualified === true || String(d.qualified).toLowerCase() === 'true') ? 'YES' : 'NO';
  if (score !== '' && score < minScore) qualified = 'NO';   // hard floor

  _writeResumeResult_(candidateId, {
    'Resume Score':     score,
    'Resume Qualified': qualified,
    'Resume Status':    'GRADED (' + ex.status + ')',
    'Resume Summary':   truncate_(String(d.summary || ''), 500)
  });
  logEvent_('RESUME_GRADED', candidateId, { score: score, qualified: qualified, source: ex.status });
  Logger.log('[RESUME] ' + candidateId + ' — score ' + score + ' qualified ' + qualified);
  return { score: score, qualified: qualified };
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKFILL: grade everyone missing a grade
// ─────────────────────────────────────────────────────────────────────────────

function backfillResumeGrades() {
  return safeRun_('backfillResumeGrades', function () {
    if (!CFG.getBool('RESUME_AI_GRADING_ENABLED', true)) return '[RESUME] disabled';
    var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
    if (!ac) return 'All Candidates missing';
    _ensureResumeColumns_();
    var headers = getHeaderRow_(ac);
    var hCid   = headers.indexOf('Candidate ID');
    var hScore = headers.indexOf('Resume Score');
    var hLink  = headers.indexOf('Resume Link');
    if (hCid === -1) return 'no Candidate ID column';
    var last = ac.getLastRow();
    if (last < 2) return 'no candidates';
    var data = ac.getRange(2, 1, last - 1, headers.length).getValues();

    var max = CFG.getInt('RESUME_BACKFILL_MAX_PER_RUN', 25);
    var done = 0, skipped = 0;
    for (var i = 0; i < data.length && done < max; i++) {
      var cid = String(data[i][hCid] || '').trim();
      if (!cid) continue;
      if (hScore !== -1 && String(data[i][hScore]).trim() !== '') { skipped++; continue; } // already graded
      if (hLink !== -1 && String(data[i][hLink] || '').trim() === '') { skipped++; continue; } // nothing to grade
      gradeResumeForCandidate_(cid);
      done++;
    }
    var msg = 'graded ' + done + ', skipped ' + skipped + ' (max ' + max + '/run)';
    Logger.log('[RESUME] backfill — ' + msg);
    toast_('Resume grading: ' + msg, 'Recruiting OS', 8);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns { text, status }. status is a short label describing the source
 * (PASTED / DOC / TXT / OCR) or why nothing was extracted (NO RESUME /
 * EXTERNAL LINK / FILE UNREADABLE / NEEDS OCR SERVICE).
 */
function _extractResumeText_(cand) {
  var raw = String((cand && (cand['Resume Link'] || cand['Resume'])) || '').trim();
  if (!raw) return { text: '', status: 'NO RESUME' };

  // Pasted resume text (long, not a URL).
  if (!/^https?:\/\//i.test(raw) && raw.length > 200) return { text: raw, status: 'PASTED' };

  var id = _driveIdFromUrl_(raw);
  if (!id) return { text: '', status: 'EXTERNAL LINK' };   // Indeed / LinkedIn / other — cannot fetch

  try {
    var file = DriveApp.getFileById(id);
    var mime = file.getMimeType();
    if (mime === MimeType.GOOGLE_DOCS) return { text: DocumentApp.openById(id).getBody().getText(), status: 'DOC' };
    if (mime === MimeType.PLAIN_TEXT)  return { text: file.getBlob().getDataAsString(), status: 'TXT' };
    return _ocrDriveFile_(file);   // PDF / image
  } catch (e) {
    logError_('_extractResumeText_', e, '', 'WARN');
    return { text: '', status: 'FILE UNREADABLE' };
  }
}

/** OCR a PDF/image Drive file into text via the advanced Drive service. */
function _ocrDriveFile_(file) {
  try {
    if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.insert) {
      return { text: '', status: 'NEEDS OCR SERVICE' };
    }
    var inserted = Drive.Files.insert(
      { title: '__resume_ocr_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      file.getBlob(),
      { ocr: true, ocrLanguage: 'en' }
    );
    var text = DocumentApp.openById(inserted.id).getBody().getText();
    try { DriveApp.getFileById(inserted.id).setTrashed(true); } catch (_) {}
    return { text: text, status: 'OCR' };
  } catch (e) {
    logError_('_ocrDriveFile_', e, '', 'WARN');
    return { text: '', status: 'NEEDS OCR SERVICE' };
  }
}

/** Extract a Drive/Docs file id from a share URL, or '' if not a Drive URL. */
function _driveIdFromUrl_(url) {
  var u = String(url || '');
  if (!/drive\.google\.com|docs\.google\.com/i.test(u)) return '';
  var m = u.match(/(?:\/d\/|[?&]id=)([-\w]{25,})/);
  if (m) return m[1];
  var m2 = u.match(/[-\w]{25,}/);
  return m2 ? m2[0] : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE-BACK
// ─────────────────────────────────────────────────────────────────────────────

function _writeResumeResult_(candidateId, updates) {
  [SHEETS.ALL_CANDIDATES, SHEETS.INTERVIEW_PIPELINE].forEach(function (name) {
    var sh = getSheetOrNull_(name);
    if (sh) updateRowWhere_(sh, 'Candidate ID', candidateId, updates);
  });
}

/** Make sure the resume output columns exist on both sheets (append if missing). */
function _ensureResumeColumns_() {
  [SHEETS.ALL_CANDIDATES, SHEETS.INTERVIEW_PIPELINE].forEach(function (name) {
    var sh = getSheetOrNull_(name);
    if (!sh) return;
    var headers = getHeaderRow_(sh);
    RESUME_OUTPUT_COLUMNS.forEach(function (col) {
      if (headers.indexOf(col) === -1) {
        var c = sh.getLastColumn() + 1;
        sh.getRange(1, c).setValue(col);
        headers.push(col);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────

function RESUME_selfTest() {
  var out = ['[RESUME] selfTest (read-only)…'];
  out.push('  - RESUME_AI_GRADING_ENABLED : ' + CFG.getBool('RESUME_AI_GRADING_ENABLED', true));
  out.push('  - RESUME_MIN_SCORE          : ' + CFG.getInt('RESUME_MIN_SCORE', 50));
  var aiSh = getSheetOrNull_(SHEETS.AI_PROMPTS);
  if (aiSh) {
    var hits = findRowsByColumnValue_(aiSh, 'Prompt Key', 'resume_review');
    out.push('  ' + (hits.length ? '✓' : '✗') + ' resume_review AI prompt' +
             (hits.length ? '' : ' — run installAllAiPrompts() to install'));
  }
  out.push('  - OCR service (Drive)       : ' + ((typeof Drive !== 'undefined' && Drive.Files) ? 'available' : 'NOT enabled (PDF resumes need it — see deploy notes)'));
  out.push('  Provide a resume via a form File-upload question, then run backfillResumeGrades().');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
