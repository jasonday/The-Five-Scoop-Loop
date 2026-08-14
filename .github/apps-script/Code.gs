/**
 * The Five Scoop Loop — submissions bridge (Google Apps Script web app).
 *
 * Deploy this bound to the responses spreadsheet, as a Web app:
 *   - Execute as: Me
 *   - Who has access: Anyone (the URL is the secret; store it as the
 *     APPS_SCRIPT_URL GitHub Actions secret)
 *
 * GET  -> returns rows where Approved = "yes" and Processed is still blank,
 *         as JSON, each including its 1-based sheet rowIndex.
 * POST -> body { rows: [{ rowIndex, fileIds: [...] }] }
 *         Stamps the Processed column and trashes the listed Drive files.
 *         Called by finalize.js only after the site content is committed.
 */

// Adjust these to match your sheet.
var SHEET_NAME = 'Form Responses 1';
var APPROVED_HEADER = 'Approved';
var PROCESSED_HEADER = 'Processed';

function getSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet not found: ' + SHEET_NAME);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return json_([]);
  }

  var headers = values[0];
  var approvedCol = headers.indexOf(APPROVED_HEADER);
  var processedCol = headers.indexOf(PROCESSED_HEADER);
  if (approvedCol === -1 || processedCol === -1) {
    throw new Error('Missing "' + APPROVED_HEADER + '" or "' + PROCESSED_HEADER + '" column.');
  }

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var approved = String(row[approvedCol] || '').trim().toLowerCase();
    var processed = String(row[processedCol] || '').trim();

    // Approved and not yet processed.
    if (approved === 'yes' && processed === '') {
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = row[c];
      }
      obj.rowIndex = i + 1; // 1-based sheet row (header is row 1)
      out.push(obj);
    }
  }

  return json_(out);
}

function doPost(e) {
  var payload = {};
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Invalid JSON body' });
  }

  var rows = payload.rows || [];
  var sheet = getSheet_();
  var headers = sheet.getDataRange().getValues()[0];
  var processedCol = headers.indexOf(PROCESSED_HEADER) + 1; // 1-based for getRange
  if (processedCol === 0) {
    return json_({ ok: false, error: 'Missing "' + PROCESSED_HEADER + '" column.' });
  }

  var stamp = new Date().toISOString();
  var marked = 0;
  var trashed = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.rowIndex) {
      sheet.getRange(r.rowIndex, processedCol).setValue(stamp);
      marked++;
    }
    var fileIds = r.fileIds || [];
    for (var j = 0; j < fileIds.length; j++) {
      try {
        DriveApp.getFileById(fileIds[j]).setTrashed(true);
        trashed++;
      } catch (err) {
        // File may already be gone; keep going.
      }
    }
  }

  return json_({ ok: true, marked: marked, trashed: trashed });
}
