/**
 * 34_Transcript_Sources.gs
 * Frank's European Service — Recruiting OS
 *
 * Gmail-query + Drive-folder transcript ingestion (e.g. Fathom emails, Drive
 * transcript files). This EXPANDS A beyond its prior single-source doctrine.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DOCTRINE NOTE (owner decision, ported from retiring build B):
 *   08_Otter_Transcripts.gs states "Otter is the SOLE transcript source."
 *   Per Travis's decision, that doctrine is RELAXED: the Zapier-written
 *   "Raw Otter Transcript Intake" sheet remains the primary live/in-person
 *   source, and THIS file adds additional pull-based sources (Gmail queries
 *   and Drive folders) that feed the SAME downstream pipeline:
 *       match → Master Transcript Archive → AI grading (09_AI_Grading.gs).
 *   No grading or matching logic is duplicated here; we reuse A's
 *   _matchCandidateToTranscript_, _inferInterviewStage_, _archiveTranscript_,
 *   _getCandidateRow_ (08) and gradeTranscript_ (09).
 * ───────────────────────────────────────────────────────────────────────────
 *
 * BEST-PRACTICE GUARANTEES (from audit — B had NEITHER):
 *   • DEDUP: every Gmail message-id and Drive file-id we ingest is recorded in
 *     the "Ingested Sources Log" sheet. A source item is never re-ingested.
 *   • PER-RUN CAP: MAX_PER_RUN = 25 (matches A's other jobs) applied to BOTH
 *     Gmail threads scanned and Drive files scanned, so a single run can never
 *     run away on a large mailbox / folder.
 *
 * Flow:
 *   importTranscriptsFromSources()
 *     for each Active row in "Transcript Sources":
 *       type=gmail → importFromGmailQuery_(source)
 *       type=drive → importFromDriveFolder_(source)
 *     each new item:
 *       • build a synthetic Otter-style rowData object (so A's matcher/archiver
 *         work unchanged)
 *       • _matchCandidateToTranscript_(rowData)  (REUSED from 08)
 *       • matched   → _archiveTranscript_(...) (REUSED from 08) → gradeTranscript_
 *       • unmatched → stage into "Transcript Inbox" as UNMATCHED
 *       • record source id in "Ingested Sources Log" (idempotency)
 *
 * Reuses A's OCR (29_Resume_Grading.gs _ocrDriveFile_/_driveIdFromUrl_) for
 * binary/pdf/word attachments and Drive files instead of B's getDataAsString().
 *
 * Public functions:
 *   importTranscriptsFromSources()   — main entry (menu + 30-min trigger)
 *   TRANSCRIPT_SOURCES_selfTest()    — read-only + synthetic, no AI call
 *
 * Concern noted in spec: _archiveTranscript_ is "private" (trailing underscore)
 * but lives in the same Apps Script project scope at runtime, so calling it is
 * safe. We pass an Otter-shaped rowData object so its appendRowByHeader_ writes
 * land on the same archive schema A's grader reads.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHEET NAMES (local — registered here so this file is self-contained; the
// integration spec lists these for folding into 00_Config SHEETS map.)
// ─────────────────────────────────────────────────────────────────────────────
var TRANSCRIPT_SOURCES_SHEET   = 'Transcript Sources';
var TRANSCRIPT_INBOX_SHEET     = 'Transcript Inbox';
var INGESTED_SOURCES_LOG_SHEET = 'Ingested Sources Log';

var TRANSCRIPT_SOURCES_HEADERS = [
  'Source Name', 'Active', 'Type', 'Modality', 'Gmail Query', 'Drive Folder ID',
  'Default Interview Type', 'Notes'
];
var TRANSCRIPT_INBOX_HEADERS = [
  'Staged At', 'Source Name', 'Source Type', 'Modality', 'Source ID',
  'Subject Or Filename', 'Meeting Date', 'Raw Snippet', 'Transcript Length',
  'Match Status', 'Notes', 'Reviewer', 'Action Taken'
];
var INGESTED_SOURCES_LOG_HEADERS = [
  'Ingested At', 'Source Name', 'Source Type', 'Source ID',
  'Outcome', 'Candidate ID', 'Match Method', 'Archive Row', 'Notes'
];

var TRANSCRIPT_SOURCES_MAX_PER_RUN = 25; // matches A's other jobs (Otter, grading, resume backfill)

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: importTranscriptsFromSources — reads config sheet, pulls each source
// ─────────────────────────────────────────────────────────────────────────────

function importTranscriptsFromSources() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('importTranscriptsFromSources', 'OK');
  return withLockOrSkip_('importTranscriptsFromSources', function () {
    if (!CFG.getBool('TRANSCRIPT_SOURCES_IMPORT_ENABLED', true)) {
      return '[TX_SRC] TRANSCRIPT_SOURCES_IMPORT_ENABLED is FALSE — skipped';
    }
    var sh = getSheetOrNull_(TRANSCRIPT_SOURCES_SHEET);
    if (!sh) {
      // Auto-create the config sheet (empty) so the operator can fill it in.
      getOrCreateSheet_(TRANSCRIPT_SOURCES_SHEET, TRANSCRIPT_SOURCES_HEADERS);
      var m0 = '[TX_SRC] "' + TRANSCRIPT_SOURCES_SHEET + '" created — add Active sources, then re-run.';
      Logger.log(m0);
      return m0;
    }

    var last = sh.getLastRow();
    if (last < 2) return '[TX_SRC] no source rows configured';

    var summary = { sources: 0, scanned: 0, matched: 0, staged: 0, skipped: 0, errors: 0 };

    for (var rowNum = 2; rowNum <= last; rowNum++) {
      var src = readRowAsObject_(sh, rowNum);
      if (!_txTruthy_(src['Active'])) continue;

      var type = String(src['Type'] || '').trim().toLowerCase();
      summary.sources++;

      safeRun_('importTranscriptsFromSources:' + (src['Source Name'] || 'row' + rowNum), function () {
        var r;
        if (type === 'gmail')      r = importFromGmailQuery_(src);
        else if (type === 'drive') r = importFromDriveFolder_(src);
        else { logError_('importTranscriptsFromSources', 'unknown Type "' + type + '" on row ' + rowNum, '', 'WARN'); return; }
        summary.scanned += r.scanned; summary.matched += r.matched;
        summary.staged  += r.staged;  summary.skipped += r.skipped; summary.errors += r.errors;
      });
    }

    var msg = '[TX_SRC] importTranscriptsFromSources — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('TRANSCRIPT_SOURCES_RUN', '', summary);
    toast_('Transcript sources: ' + summary.matched + ' matched, ' + summary.staged + ' staged.', 'Recruiting OS', 8);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GMAIL SOURCE
// ─────────────────────────────────────────────────────────────────────────────

function importFromGmailQuery_(source) {
  var stats = { scanned: 0, matched: 0, staged: 0, skipped: 0, errors: 0 };
  var sourceName = String(source['Source Name'] || 'Gmail');
  var query      = String(source['Gmail Query'] || '').trim();
  if (!query) { logError_('importFromGmailQuery_', 'empty Gmail Query for source "' + sourceName + '"', '', 'WARN'); return stats; }

  var threads;
  try { threads = GmailApp.search(query, 0, TRANSCRIPT_SOURCES_MAX_PER_RUN); }
  catch (e) { logError_('importFromGmailQuery_:search', e, '', 'WARN'); stats.errors++; return stats; }

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var mi = 0; mi < msgs.length; mi++) {
      var m = msgs[mi];
      var sourceId = '';
      try { sourceId = String(m.getId() || ''); } catch (eId) { sourceId = ''; }
      if (!sourceId) { stats.skipped++; continue; }

      stats.scanned++;

      // DEDUP — already ingested this Gmail message-id?
      if (_txAlreadyIngested_(sourceId)) { stats.skipped++; continue; }

      try {
        var subject = '';
        var received = new Date();
        try { subject  = String(m.getSubject() || ''); } catch (_) {}
        try { received = m.getDate() || new Date(); } catch (_) {}

        var text = '';
        try { text = String(m.getPlainBody() || ''); } catch (_) {}
        text += _txReadGmailAttachments_(m);

        var rowData = _txBuildRowData_({
          sourceName:    sourceName,
          sourceType:    'gmail',
          sourceId:      sourceId,
          title:         subject,
          meetingDate:   received,
          text:          text,
          sourceApp:     'Gmail (' + sourceName + ')',
          transcriptUrl: '',
          defaultType:   source['Default Interview Type'],
          modality:      source['Modality'],
          query:         source['Gmail Query']
        });

        var outcome = _txIngestRowData_(rowData, sourceName, 'gmail', sourceId);
        if (outcome === 'matched') stats.matched++;
        else if (outcome === 'staged') stats.staged++;
        else stats.skipped++;
      } catch (eMsg) {
        stats.errors++;
        logError_('importFromGmailQuery_:msg', eMsg, '', 'ERROR');
      }
    }
  }
  return stats;
}

/** Concatenate readable text from text/pdf/word attachments using A's OCR. */
function _txReadGmailAttachments_(message) {
  var out = '';
  var atts = [];
  try { atts = message.getAttachments() || []; } catch (e) { return ''; }
  for (var i = 0; i < atts.length; i++) {
    var a = atts[i];
    try {
      var ct = String(a.getContentType() || '').toLowerCase();
      var name = String(a.getName() || '').toLowerCase();
      if (a.getSize && a.getSize() > 5000000) continue; // 5MB cap, matches B's guard
      if (/text\/|plain/i.test(ct) || /\.txt$|\.vtt$|\.srt$/i.test(name)) {
        out += '\n\n' + a.getDataAsString();
      } else if (/pdf|msword|officedocument|wordprocessing/i.test(ct) || /\.pdf$|\.docx?$/i.test(name)) {
        out += '\n\n' + _txOcrBlob_(a.copyBlob());
      }
    } catch (e2) { /* skip unreadable attachment */ }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVE SOURCE
// ─────────────────────────────────────────────────────────────────────────────

function importFromDriveFolder_(source) {
  var stats = { scanned: 0, matched: 0, staged: 0, skipped: 0, errors: 0 };
  var sourceName = String(source['Source Name'] || 'Drive');
  var folderId   = String(source['Drive Folder ID'] || '').trim();
  if (!folderId) { logError_('importFromDriveFolder_', 'empty Drive Folder ID for source "' + sourceName + '"', '', 'WARN'); return stats; }

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) { logError_('importFromDriveFolder_:folder', e, '', 'WARN'); stats.errors++; return stats; }

  var files;
  try { files = folder.getFiles(); } catch (e2) { logError_('importFromDriveFolder_:list', e2, '', 'WARN'); stats.errors++; return stats; }

  while (files.hasNext() && stats.scanned < TRANSCRIPT_SOURCES_MAX_PER_RUN) {
    var f = files.next();
    var sourceId = '';
    try { sourceId = String(f.getId() || ''); } catch (eId) { sourceId = ''; }
    if (!sourceId) { stats.skipped++; continue; }

    stats.scanned++;

    // DEDUP — already ingested this Drive file-id?
    if (_txAlreadyIngested_(sourceId)) { stats.skipped++; continue; }

    try {
      var fileName = String(f.getName() || '');
      var updated = new Date();
      try { updated = f.getLastUpdated() || new Date(); } catch (_) {}
      var text = _txReadDriveFile_(f);

      var rowData = _txBuildRowData_({
        sourceName:    sourceName,
        sourceType:    'drive',
        sourceId:      sourceId,
        title:         fileName,
        meetingDate:   updated,
        text:          text,
        sourceApp:     'Drive (' + sourceName + ')',
        transcriptUrl: 'https://drive.google.com/file/d/' + sourceId + '/view',
        defaultType:   source['Default Interview Type'],
        modality:      source['Modality'],
        query:         ''
      });

      var outcome = _txIngestRowData_(rowData, sourceName, 'drive', sourceId);
      if (outcome === 'matched') stats.matched++;
      else if (outcome === 'staged') stats.staged++;
      else stats.skipped++;
    } catch (eFile) {
      stats.errors++;
      logError_('importFromDriveFolder_:file', eFile, '', 'ERROR');
    }
  }
  return stats;
}

/** Read text from a Drive file: Google Doc / plain text directly, else A's OCR. */
function _txReadDriveFile_(file) {
  try {
    var mime = file.getMimeType();
    if (mime === MimeType.GOOGLE_DOCS) return DocumentApp.openById(file.getId()).getBody().getText();
    if (mime === MimeType.PLAIN_TEXT)  return file.getBlob().getDataAsString();
    if (/^text\//i.test(String(mime))) return file.getBlob().getDataAsString();
    // PDF / Word / image → reuse A's OCR
    return _txOcrFile_(file);
  } catch (e) {
    logError_('_txReadDriveFile_', e, '', 'WARN');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: ingest one synthetic rowData — match, archive+grade or stage, then log
// ─────────────────────────────────────────────────────────────────────────────

function _txIngestRowData_(rowData, sourceName, sourceType, sourceId) {
  var transcript = String(rowData['Transcript Text'] || '');
  var minChars = CFG.getInt('TRANSCRIPT_MIN_CHARACTERS_FOR_AI', 200);

  // Too-short items are staged (so the operator can see them) — never silently dropped.
  if (transcript.length < minChars) {
    _txStageUnmatched_(rowData, sourceName, sourceType, sourceId,
      'Transcript too short (' + transcript.length + ' < ' + minChars + ') — review/attach full transcript.');
    _txRecordIngested_(sourceName, sourceType, sourceId, 'STAGED_SHORT', '', '', '',
      'len=' + transcript.length);
    return 'staged';
  }

  // Modality: Otter = in-person ONLY, Fathom = online ONLY. Park vendor↔modality
  // conflicts (e.g. an Otter item arriving on a Fathom/online source).
  var cls = _classifyTranscriptModality_(rowData, rowData['__modality']);
  if (cls.conflict) {
    _txStageUnmatched_(rowData, sourceName, sourceType, sourceId,
      'Modality conflict: vendor=' + cls.vendor + ' does not match the source modality — parked, not graded.', cls.modality);
    _txRecordIngested_(sourceName, sourceType, sourceId, 'MODALITY_CONFLICT', '', MATCH_METHOD.NONE, '', 'vendor=' + cls.vendor);
    logEvent_('TRANSCRIPT_SOURCE_MODALITY_CONFLICT', '', { source: sourceName, sourceId: sourceId, vendor: cls.vendor });
    return 'staged';
  }

  // REUSE A's matcher (08), modality-gated. Online meetings require a verified
  // candidate identity — unrelated online calls are skipped, never ingested.
  var match = _matchCandidateToTranscript_(rowData, cls.modality);
  if (!match) {
    if (cls.modality === 'online' && CFG.getBool('ONLINE_REQUIRE_CANDIDATE_MATCH', true)) {
      _txStageUnmatched_(rowData, sourceName, sourceType, sourceId,
        'Online meeting with no candidate identity — skipped (not ingested or graded).', cls.modality);
      _txRecordIngested_(sourceName, sourceType, sourceId, 'SKIPPED_NO_CANDIDATE', '', MATCH_METHOD.NONE, '', '');
      logEvent_('TRANSCRIPT_SOURCE_ONLINE_SKIPPED', '', {
        source: sourceName, type: sourceType, sourceId: sourceId, title: rowData['Meeting Title']
      });
      return 'skipped';
    }
    _txStageUnmatched_(rowData, sourceName, sourceType, sourceId, 'No candidate match — manual resolution needed.', cls.modality);
    _txRecordIngested_(sourceName, sourceType, sourceId, 'UNMATCHED', '', MATCH_METHOD.NONE, '', '');
    logEvent_('TRANSCRIPT_SOURCE_UNMATCHED', '', {
      source: sourceName, type: sourceType, sourceId: sourceId, title: rowData['Meeting Title']
    });
    return 'staged';
  }

  var candidate = _getCandidateRow_(match.candidateId);
  if (!candidate) {
    _txStageUnmatched_(rowData, sourceName, sourceType, sourceId,
      'Matched candidateId ' + match.candidateId + ' not found in pipeline/candidates.', cls.modality);
    _txRecordIngested_(sourceName, sourceType, sourceId, 'MATCH_ORPHAN', match.candidateId, match.method, '', '');
    return 'staged';
  }

  // REUSE A's stage inference + archive writer (08).
  var stage = _inferInterviewStage_(rowData, candidate);
  var archiveRow = _archiveTranscript_(rowData, match.candidateId, candidate, stage, match, cls.modality);

  // Dispatch AI grading via A's existing grader (09).
  var outcome = 'archived';
  if (CFG.getBool('AI_GRADING_ENABLED', true) && typeof gradeTranscript_ === 'function') {
    safeRun_('txSrc:gradeTranscript', function () { gradeTranscript_(archiveRow); });
    outcome = 'graded';
  }

  _txRecordIngested_(sourceName, sourceType, sourceId, outcome.toUpperCase(),
    match.candidateId, match.method, archiveRow, '');
  logEvent_('TRANSCRIPT_SOURCE_PROCESSED', match.candidateId, {
    source: sourceName, type: sourceType, sourceId: sourceId,
    archiveRow: archiveRow, stage: stage, matchMethod: match.method, confidence: match.confidence
  });
  return 'matched';
}

/** Build an Otter-shaped rowData object so A's 08 helpers work unchanged. */
function _txBuildRowData_(p) {
  var emails = (String(p.text || '').match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []).join(', ');
  return {
    'Otter Source ID':  p.sourceId,            // reuse archive's source-id slot
    'Meeting Title':    p.title || '',
    'Meeting Date':     p.meetingDate ? shopDateTime_(p.meetingDate) : shopDateTime_(),
    'Transcript Text':  String(p.text || ''),
    'Transcript URL':   p.transcriptUrl || '',
    'Audio URL':        '',
    // Participants seeds the matcher's email extraction from body text.
    'Participants':     emails,
    'Organizer Email':  '',
    'Source App':       p.sourceApp || 'External',
    '__defaultType':    p.defaultType || '',     // advisory; A's _inferInterviewStage_ uses title/status
    '__modality':       p.modality || '',         // source-declared modality (in_person|online)
    '__sourceQuery':    p.query || ''             // feeds vendor detection (e.g. from:(fathom.video))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGING — unmatched / short items go to Transcript Inbox for manual handling
// ─────────────────────────────────────────────────────────────────────────────

function _txStageUnmatched_(rowData, sourceName, sourceType, sourceId, note, modality) {
  var sh = getOrCreateSheet_(TRANSCRIPT_INBOX_SHEET, TRANSCRIPT_INBOX_HEADERS);
  var text = String(rowData['Transcript Text'] || '');
  withLock_(function () {
    appendRowByHeader_(sh, {
      'Staged At':           shopDateTime_(),
      'Source Name':         sourceName,
      'Source Type':         sourceType,
      'Modality':            modality || '',
      'Source ID':           sourceId,
      'Subject Or Filename': rowData['Meeting Title'] || '',
      'Meeting Date':        rowData['Meeting Date'] || '',
      'Raw Snippet':         truncate_(text, 500),
      'Transcript Length':   text.length,
      'Match Status':        'UNMATCHED',
      'Notes':               note || 'Awaiting manual review.',
      'Reviewer':            '',
      'Action Taken':        ''
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUP / IDEMPOTENCY — Ingested Sources Log
// ─────────────────────────────────────────────────────────────────────────────

/** True if this source id was already recorded in the ingestion log. */
function _txAlreadyIngested_(sourceId) {
  if (!sourceId) return false;
  var sh = getSheetOrNull_(INGESTED_SOURCES_LOG_SHEET);
  if (!sh) return false;
  return findRowsByColumnValue_(sh, 'Source ID', sourceId).length > 0;
}

function _txRecordIngested_(sourceName, sourceType, sourceId, outcome, candidateId, matchMethod, archiveRow, notes) {
  var sh = getOrCreateSheet_(INGESTED_SOURCES_LOG_SHEET, INGESTED_SOURCES_LOG_HEADERS);
  withLock_(function () {
    appendRowByHeader_(sh, {
      'Ingested At':  shopDateTime_(),
      'Source Name':  sourceName || '',
      'Source Type':  sourceType || '',
      'Source ID':    sourceId || '',
      'Outcome':      outcome || '',
      'Candidate ID': candidateId || '',
      'Match Method': matchMethod || '',
      'Archive Row':  archiveRow || '',
      'Notes':        notes || ''
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR ADAPTERS — reuse 29_Resume_Grading.gs OCR, falling back gracefully.
// _ocrDriveFile_ returns { text, status }; we unwrap to a plain string here.
// ─────────────────────────────────────────────────────────────────────────────

function _txOcrFile_(file) {
  if (typeof _ocrDriveFile_ === 'function') {
    var r = _ocrDriveFile_(file);
    return (r && r.text) ? r.text : '';
  }
  return '';
}

/** OCR an arbitrary blob (Gmail attachment) by staging it as a temp Drive file. */
function _txOcrBlob_(blob) {
  try {
    if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.insert) return '';
    var inserted = Drive.Files.insert(
      { title: '__tx_ocr_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      blob,
      { ocr: true, ocrLanguage: 'en' }
    );
    var text = DocumentApp.openById(inserted.id).getBody().getText();
    try { DriveApp.getFileById(inserted.id).setTrashed(true); } catch (_) {}
    return text || '';
  } catch (e) {
    logError_('_txOcrBlob_', e, '', 'WARN');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _txTruthy_(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === '1' || s === 'Y' || s === 'X' || s === '✓';
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only checks + a synthetic dedup round-trip (no AI call).
// Creates and cleans up its own rows in the log/inbox; touches no candidate.
// ─────────────────────────────────────────────────────────────────────────────

function TRANSCRIPT_SOURCES_selfTest() {
  var out = ['[TX_SRC] selfTest starting (no AI call)…'];

  // 1) Helper presence (proves we can reuse A's pipeline at runtime)
  var reusable = {
    '_matchCandidateToTranscript_': (typeof _matchCandidateToTranscript_ === 'function'),
    '_inferInterviewStage_':        (typeof _inferInterviewStage_ === 'function'),
    '_archiveTranscript_':          (typeof _archiveTranscript_ === 'function'),
    '_getCandidateRow_':            (typeof _getCandidateRow_ === 'function'),
    'gradeTranscript_':             (typeof gradeTranscript_ === 'function')
  };
  Object.keys(reusable).forEach(function (fn) {
    out.push('  ' + (reusable[fn] ? '✓' : '✗') + ' reusable: ' + fn);
  });

  out.push('  ─ MAX_PER_RUN              : ' + TRANSCRIPT_SOURCES_MAX_PER_RUN);
  out.push('  ─ OCR service (Drive)      : ' + ((typeof Drive !== 'undefined' && Drive.Files) ? 'available' : 'NOT enabled (PDF/Word attachments need it)'));

  // 2) Config sheet presence
  var srcSh = getSheetOrNull_(TRANSCRIPT_SOURCES_SHEET);
  out.push('  ' + (srcSh ? '✓' : '⚠') + ' "' + TRANSCRIPT_SOURCES_SHEET + '"' +
           (srcSh ? ' present, ' + Math.max(0, srcSh.getLastRow() - 1) + ' source rows' : ' missing — will auto-create on first run'));

  // 3) Synthetic dedup round-trip
  var fakeId = 'TXSELFTEST-' + Date.now();
  var before = _txAlreadyIngested_(fakeId);
  _txRecordIngested_('SelfTest', 'gmail', fakeId, 'TEST', '', MATCH_METHOD.NONE, '', 'selftest row');
  var after = _txAlreadyIngested_(fakeId);
  out.push('  ' + (!before && after ? '✓' : '✗') + ' dedup record+detect (before=' + before + ' after=' + after + ')');

  // 4) Build-rowData shape check
  var rd = _txBuildRowData_({
    sourceName: 'SelfTest', sourceType: 'gmail', sourceId: fakeId,
    title: 'SelfTest interview with nobody@example.com',
    meetingDate: new Date(), text: 'short body referencing nobody@example.com',
    sourceApp: 'Gmail (SelfTest)', transcriptUrl: '', defaultType: 'PhoneScreen'
  });
  out.push('  ' + (rd['Participants'].indexOf('nobody@example.com') !== -1 ? '✓' : '✗') +
           ' _txBuildRowData_ extracted email into Participants');

  // 5) Cleanup the synthetic log row
  try {
    var logSh = getSheetOrNull_(INGESTED_SOURCES_LOG_SHEET);
    if (logSh) {
      var hits = findRowsByColumnValue_(logSh, 'Source ID', fakeId);
      for (var i = hits.length - 1; i >= 0; i--) logSh.deleteRow(hits[i].rowNum);
      out.push('  ✓ cleaned up ' + hits.length + ' synthetic log row(s)');
    }
  } catch (e) { out.push('  ⚠ cleanup failed: ' + e.message); }

  out.push('[TX_SRC] selfTest done. Configure "' + TRANSCRIPT_SOURCES_SHEET + '" then run importTranscriptsFromSources().');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
