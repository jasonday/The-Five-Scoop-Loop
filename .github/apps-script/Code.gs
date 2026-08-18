/**
 * Scoop Loops — submissions bridge (Google Apps Script web app).
 *
 * Deploy this bound to the responses spreadsheet, as a Web app:
 *   - Execute as: Me
 *   - Who has access: Anyone (the URL is the secret; store it as the
 *     APPS_SCRIPT_URL GitHub Actions secret)
 *
 * GET  -> returns rows where Approved = "yes" and Processed is blank. For each,
 *         a random ID is written to the ID column if it is empty, so every row
 *         has a stable identifier. Each returned row includes its ID and its
 *         1-based rowIndex.
 * POST -> body { rows: [{ id, rowIndex, fileIds: [...] }] }
 *         Stamps the Processed column and trashes the listed Drive files.
 *         Rows are matched by ID (falling back to rowIndex), so deleting or
 *         reordering rows never marks the wrong one. Called by finalize.js
 *         after the site content is committed.
 */

// Adjust these to match your sheet. Add an "ID" column (any position); it is
// filled automatically. Without it, the script falls back to row position.
var SHEET_NAME = 'Form Responses 1';
var APPROVED_HEADER = 'Approved';
var PROCESSED_HEADER = 'Processed';
var ID_HEADER = 'ID';

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
  var idCol = headers.indexOf(ID_HEADER); // -1 if the column does not exist
  if (approvedCol === -1 || processedCol === -1) {
    throw new Error('Missing "' + APPROVED_HEADER + '" or "' + PROCESSED_HEADER + '" column.');
  }

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var approved = String(row[approvedCol] || '').trim().toLowerCase();
    var processed = String(row[processedCol] || '').trim();
    if (approved !== 'yes' || processed !== '') continue;

    // Give the row a stable random ID if it does not have one yet.
    if (idCol !== -1) {
      var id = String(row[idCol] || '').trim();
      if (!id) {
        id = Utilities.getUuid();
        sheet.getRange(i + 1, idCol + 1).setValue(id);
        row[idCol] = id;
      }
    }

    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    obj.rowIndex = i + 1; // 1-based sheet row (header is row 1)
    out.push(obj);
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
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var processedCol = headers.indexOf(PROCESSED_HEADER);
  var idCol = headers.indexOf(ID_HEADER);
  if (processedCol === -1) {
    return json_({ ok: false, error: 'Missing "' + PROCESSED_HEADER + '" column.' });
  }

  // ID -> 1-based row number, so we can match rows even after deletion/reorder.
  var idToRow = {};
  if (idCol !== -1) {
    for (var i = 1; i < values.length; i++) {
      var idv = String(values[i][idCol] || '').trim();
      if (idv) idToRow[idv] = i + 1;
    }
  }

  var stamp = new Date().toISOString();
  var marked = 0;
  var trashed = 0;

  for (var k = 0; k < rows.length; k++) {
    var r = rows[k];
    var rowNum = (r.id && idToRow[r.id]) ? idToRow[r.id] : (r.rowIndex || null);
    if (rowNum) {
      sheet.getRange(rowNum, processedCol + 1).setValue(stamp);
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
