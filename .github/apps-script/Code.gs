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

// If this script is bound to the responses spreadsheet (Extensions > Apps
// Script from inside the sheet), getActiveSpreadsheet() finds it and no
// further setup is needed. If it is a standalone script instead, that returns
// null, so we fall back to a Script Property holding the sheet's ID -- set it
// once via setSpreadsheetId() below, or in Project Settings > Script
// Properties as SPREADSHEET_ID.
function getSpreadsheet_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      'No active spreadsheet (this is a standalone script) and no ' +
      'SPREADSHEET_ID script property is set. Run setSpreadsheetId(\'<id>\') ' +
      'once from the editor, or bind this script to the sheet via ' +
      'Extensions > Apps Script inside the spreadsheet.'
    );
  }
  return SpreadsheetApp.openById(id);
}

// Run this once from the Apps Script editor (select it in the function
// dropdown, click Run) if using a standalone script. Paste the spreadsheet ID
// from its URL: https://docs.google.com/spreadsheets/d/PASTE_THIS_PART/edit
function setSpreadsheetId(id) {
  if (!id) throw new Error('Pass the spreadsheet ID, e.g. setSpreadsheetId("1Vpa4wf...")');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_NAME);
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
