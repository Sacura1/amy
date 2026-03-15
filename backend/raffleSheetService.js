const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class RaffleSheetService {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = process.env.RAFFLE_SHEET_SPREADSHEET_ID;
    this.ledgerSheetName = process.env.RAFFLE_SHEET_NAME || 'Amy_Raffle_Ledger';
    this.queueSpreadsheetId = process.env.RAFFLE_QUEUE_SPREADSHEET_ID || '1IRRbE4NQU-t5UgjbmB2hiWYbpj_UYsWhGny1-WfJiBw';
    this.queueSheetName = process.env.RAFFLE_QUEUE_SHEET_NAME || 'Sheet1';
    this.pool = null;
  }

  async initialize(pool) {
    this.pool = pool;
    try {
      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        const auth = new google.auth.GoogleAuth({
          credentials: creds,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.sheets = google.sheets({ version: 'v4', auth });
        console.log('? Raffle Sheet Service initialized');
        return true;
      }
      return false;
    } catch (err) {
      console.error('? Raffle Sheet Service init error:', err.message);
      return false;
    }
  }

  _mapHeaders(rows) {
    if (!rows || rows.length === 0) return {};
    const headers = rows[0];
    const map = {};
    headers.forEach((h, i) => {
      if (h) map[h.trim().toLowerCase()] = i;
    });
    return map;
  }

  _fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  _mapStatus(s) {
    if (s === 'COMPLETED') return 'DRAWN';
    return s;
  }

  async processQueue() {
    if (!this.sheets || !this.pool || !this.queueSpreadsheetId) return;
    try {
      console.log('?? Checking Raffle Queue...');
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.queueSpreadsheetId,
        range: `'${this.queueSheetName}'!A1:Z100`,
      });
      const rows = res.data.values;
      if (!rows || rows.length < 2) return;

      const headerMap = this._mapHeaders(rows);
      const queueData = rows.slice(1);

      const activeRes = await this.pool.query("SELECT slot_id FROM raffles WHERE status IN ('TNM', 'LIVE', 'DRAW_PENDING')");
      const occupiedSlots = new Set(activeRes.rows.map(r => r.slot_id).filter(s => s));

      for (let i = 0; i < queueData.length; i++) {
        const row = queueData[i];
        const slotId = row[headerMap['slot_id']];
        const raffleIdInSheet = row[headerMap['raffle_id']];

        if (slotId && !occupiedSlots.has(slotId) && !raffleIdInSheet) {
          console.log(`? Creating new raffle for slot: ${slotId}`);
          
          const title = row[headerMap['raffle_title']];
          const desc = row[headerMap['raffle_description']];
          const asset = row[headerMap['prize_asset']];
          const img = asset ? `/prizes/${asset.trim()}` : '/prizes/prize-default.png';
          const points = parseInt(row[headerMap['threshold_points']]) || 5000;
          const users = parseInt(row[headerMap['threshold_users']]) || 10;
          const hours = parseInt(row[headerMap['countdown_hours']]) || 24;
          const novelty = row[headerMap['novelty_name']];

          const result = await this.pool.query(
            `INSERT INTO raffles (title, prize_description, image_url, countdown_hours, threshold_points, threshold_participants, slot_id, novelty_name, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TNM') RETURNING id`,
            [title, desc, img, hours, points, users, slotId, novelty]
          );
          
          const newId = result.rows[0].id;
          const rowNum = i + 2;
          const colLetter = String.fromCharCode(65 + headerMap['raffle_id']);
          
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.queueSpreadsheetId,
            range: `'${this.queueSheetName}'!${colLetter}${rowNum}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[newId]] },
          });

          occupiedSlots.add(slotId);
        }
      }
    } catch (err) {
      console.error('? Error processing queue:', err.message);
    }
  }

  async sync() {
    if (!this.sheets || !this.spreadsheetId || !this.pool) return;
    try {
      console.log('?? Syncing Raffle Ledger...');
      const dbResult = await this.pool.query("SELECT * FROM raffles ORDER BY id ASC");
      const raffles = dbResult.rows;

      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.ledgerSheetName}'!A1:Z1000`,
      });
      const rows = res.data.values || [];
      const headerMap = this._mapHeaders(rows);
      
      const existingRows = {};
      rows.forEach((row, i) => {
        const id = row[headerMap['raffle_id']];
        if (id) existingRows[id] = i + 1;
      });

      for (const r of raffles) {
        const rowData = [];
        Object.keys(headerMap).forEach(key => {
          const idx = headerMap[key];
          let val = '';
          switch(key) {
            case 'raffle_id': val = r.id; break;
            case 'slot_id': val = r.slot_id; break;
            case 'novelty_name': val = r.novelty_name; break;
            case 'raffle_title': val = r.title; break;
            case 'raffle_description': val = r.prize_description; break;
            case 'raffle_state': val = this._mapStatus(r.status); break;
            case 'threshold_points': val = r.threshold_points; break;
            case 'threshold_users': val = r.threshold_participants; break;
            case 'countdown_hours': val = r.countdown_hours; break;
            case 'raffle_created_at': val = this._fmtTs(r.created_at); break;
            case 'tnm_completed_at': val = this._fmtTs(r.live_at); break;
            case 'winner_drawn_at': val = this._fmtTs(r.ends_at); break;
            case 'winner_wallet': val = r.winner_wallet; break;
            case 'unique_participants': val = r.unique_participants; break;
            case 'total_points_committed': val = r.total_points_committed; break;
            case 'total_tickets_at_draw': val = r.total_tickets; break;
          }
          if (val !== undefined) rowData[idx] = val;
        });

        const rowNum = existingRows[r.id];
        if (rowNum) {
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `'${this.ledgerSheetName}'!A${rowNum}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] },
          });
        } else {
          await this.sheets.spreadsheets.values.append({
            spreadsheetId: this.spreadsheetId,
            range: `'${this.ledgerSheetName}'!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] },
          });
        }
      }
    } catch (err) {
      console.error('? Error syncing ledger:', err.message);
    }
  }
}

module.exports = new RaffleSheetService();
