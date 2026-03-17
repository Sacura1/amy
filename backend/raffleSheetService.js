const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class RaffleSheetService {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = process.env.RAFFLE_SHEET_SPREADSHEET_ID;
    this.ledgerSheetName = process.env.RAFFLE_SHEET_NAME || 'Sheet1';
    this.queueSpreadsheetId = process.env.RAFFLE_QUEUE_SPREADSHEET_ID || '1IRRbE4NQU-t5UgjbmB2hiWYbpj_UYsWhGny1-WfJiBw';
    this.queueSheetName = process.env.RAFFLE_QUEUE_SHEET_NAME || 'Amy_Raffle_Queue';
    this.pool = null;
    this.pipelineTarget = parseInt(process.env.RAFFLE_QUEUE_PIPELINE_TARGET, 10) || 3;
    const slotEnv = process.env.RAFFLE_SLOT_IDS || 'slot_1,slot_2,slot_3,slot_4,slot_5';
    this.defaultSlots = slotEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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

  /**
   * Queue Pipeline: keep a slot-based buffer of upcoming raffles ordered by queue_position
   */
  async processQueue(targetSlotId = null) {
    if (!this.sheets || !this.pool || !this.queueSpreadsheetId) return;
    const normalizedTargetSlot = targetSlotId ? targetSlotId.toString().trim().toLowerCase() : null;

    try {
      console.log(`?? Checking Queue for slot: ${normalizedTargetSlot || 'ALL'}...`);
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.queueSpreadsheetId,
        range: `'${this.queueSheetName}'!A1:Z200`,
      });
      const rows = res.data.values;
      if (!rows || rows.length < 2) return;

      const headerMap = this._mapHeaders(rows);
      const slotIdx = headerMap['slot_id'];
      const queueIdx = headerMap['queue_position'];
      if (slotIdx === undefined || queueIdx === undefined) {
        console.warn('?? Queue sheet missing slot_id or queue_position columns');
        return;
      }

      const queueRows = rows.slice(1)
        .map(row => row.map(cell => (typeof cell === 'string' ? cell.trim() : cell)));

      const slotsFromQueue = [...new Set(queueRows.map(row => (row[slotIdx] || '').toString().trim().toLowerCase()).filter(Boolean))];
      const slotsToProcess = normalizedTargetSlot
        ? [normalizedTargetSlot]
        : (slotsFromQueue.length ? slotsFromQueue : this.defaultSlots);

      for (const slotId of slotsToProcess) {
        if (!slotId) continue;
        const slotRows = queueRows.filter(row => (row[slotIdx] || '').toString().trim().toLowerCase() === slotId);
        if (slotRows.length === 0) {
          console.log(`?? No queue rows available for slot ${slotId}`);
          continue;
        }

        const activeRes = await this.pool.query(
          "SELECT id FROM raffles WHERE slot_id = $1 AND status IN ('TNM','LIVE','DRAW_PENDING')",
          [slotId]
        );
        if (activeRes.rows.length > 0) {
          console.log(`?? Slot ${slotId} already has active raffles (count=${activeRes.rows.length}), skipping queue`);
          continue;
        }

        const consumedRes = await this.pool.query(
          "SELECT queue_position FROM consumed_queue_items WHERE slot_id = $1",
          [slotId]
        );
        const consumedPositions = new Set(
          consumedRes.rows.map(r => parseInt(r.queue_position, 10)).filter(n => !Number.isNaN(n))
        );

        slotRows.sort((a, b) => {
          const aPos = parseInt(a[queueIdx], 10);
          const bPos = parseInt(b[queueIdx], 10);
          if (Number.isNaN(aPos) && Number.isNaN(bPos)) return 0;
          if (Number.isNaN(aPos)) return 1;
          if (Number.isNaN(bPos)) return -1;
          return aPos - bPos;
        });

        let created = false;
        for (const row of slotRows) {
          const queuePos = parseInt(row[queueIdx], 10);
          if (Number.isNaN(queuePos) || consumedPositions.has(queuePos)) continue;

          const success = await this._createRaffleFromQueueRow(slotId, queuePos, row, headerMap);
          if (success) {
            created = true;
          }
          break;
        }

        if (!created) {
          console.log(`?? Queue for slot ${slotId} has no unused row, skipping`);
        }
      }
    } catch (err) {
      console.error('? Error processing queue:', err.message);
    }
  }

  _getQueueCell(row, headerMap, key) {
    const idx = headerMap[key];
    if (idx === undefined) return '';
    const value = row[idx];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value.trim() : String(value).trim();
  }

  _parseInt(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  _parseFloat(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  async _createRaffleFromQueueRow(slotId, queuePosition, row, headerMap) {
    const title = this._getQueueCell(row, headerMap, 'raffle_title') || 'Untitled Prize';
    const desc = this._getQueueCell(row, headerMap, 'raffle_description') || '';
    const countdownHours = this._parseInt(this._getQueueCell(row, headerMap, 'countdown_hours'), 24);
    const thresholdPoints = this._parseInt(this._getQueueCell(row, headerMap, 'threshold_points'), 5000);
    const thresholdUsers = this._parseInt(this._getQueueCell(row, headerMap, 'threshold_users'), 10);
    const assetValue = this._getQueueCell(row, headerMap, 'prize_asset');
    const normalizedAsset = assetValue.replace(/^\/+/, '');
    const imageUrl = normalizedAsset ? `/prizes/${normalizedAsset}` : '/prizes/prize-default.png';
    const novelty = this._getQueueCell(row, headerMap, 'novelty_name') || null;
    const partner = this._getQueueCell(row, headerMap, 'partner') || null;
    const campaign = this._getQueueCell(row, headerMap, 'campaign') || null;
    const prizeType = this._getQueueCell(row, headerMap, 'prize_type') || null;
    const prizeValueUsd = this._parseFloat(this._getQueueCell(row, headerMap, 'prize_value_usd'), 0);
    const pointsPerTicket = this._parseInt(this._getQueueCell(row, headerMap, 'points_per_ticket'), 50);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const insertRes = await client.query(
        `INSERT INTO raffles (title, prize_description, image_url, countdown_hours, threshold_points, threshold_participants, slot_id, novelty_name, partner, campaign, prize_type, prize_asset, prize_value_usd, points_per_ticket, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'TNM')
         RETURNING id`,
        [title, desc, imageUrl, countdownHours, thresholdPoints, thresholdUsers, slotId, novelty, partner, campaign, prizeType, normalizedAsset || null, prizeValueUsd, pointsPerTicket]
      );
      await client.query(
        `INSERT INTO consumed_queue_items (slot_id, queue_position)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [slotId, queuePosition]
      );
      await client.query('COMMIT');
      console.log(`? Queued slot=${slotId} pos=${queuePosition} (raffle id=${insertRes.rows[0].id})`);
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('? Error creating raffle from queue row:', err.message);
      return false;
    } finally {
      client.release();
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
            case 'partner': val = r.partner; break;
            case 'campaign': val = r.campaign; break;
            case 'raffle_title': val = r.title; break;
            case 'raffle_description': val = r.prize_description; break;
            case 'prize_type': val = r.prize_type; break;
            case 'prize_asset': val = r.prize_asset; break;
            case 'prize_value_usd': val = r.prize_value_usd; break;
            case 'points_per_ticket': val = r.points_per_ticket; break;
            case 'raffle_state': val = this._mapStatus(r.status); break;
            case 'raffle_status': val = r.status; break;
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
