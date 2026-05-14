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
    this._isSyncing = false;
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
        console.log('✅ Raffle Sheet Service initialized');
        return true;
      }
      return false;
    } catch (err) {
      console.error('❌ Raffle Sheet Service init error:', err.message);
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

  _headerIndex(headerMap, ...names) {
    for (const name of names) {
      const direct = headerMap[name];
      if (direct !== undefined) return direct;
    }

    const normalizedNames = names.map(name => name.toLowerCase().replace(/\s+/g, '_'));
    for (const [key, idx] of Object.entries(headerMap)) {
      const normalizedKey = key.toLowerCase().replace(/\s+/g, '_');
      if (normalizedNames.includes(normalizedKey)) return idx;
    }
    return undefined;
  }

  _parseSheetTimestamp(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
      const ms = Math.round((value - 25569) * 86400 * 1000);
      return new Date(ms).toISOString();
    }

    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw
      .replace(/[–—]/g, ' ')
      .replace(/\bUTC\b/i, 'Z')
      .replace(/\s+/g, ' ')
      .trim();
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  async _syncPayoutFieldsFromSheet(rows, headerMap) {
    const raffleIdCol = this._headerIndex(headerMap, 'raffle_id', 'raffle id');
    const prizeSentCol = this._headerIndex(headerMap, 'prize_sent_at', 'prize sent at') ?? 27;
    const payoutTxCol = this._headerIndex(headerMap, 'payout_tx_hash', 'payout tx hash') ?? 28;
    if (raffleIdCol === undefined || (prizeSentCol === undefined && payoutTxCol === undefined)) return;

    const updates = [];
    rows.slice(1).forEach(row => {
      const raffleId = parseInt(row[raffleIdCol], 10);
      if (!raffleId) return;
      const prizeSentAt = prizeSentCol === undefined ? undefined : this._parseSheetTimestamp(row[prizeSentCol]);
      const payoutTxHash = payoutTxCol === undefined ? undefined : String(row[payoutTxCol] || '').trim();
      if (prizeSentAt || payoutTxHash) {
        updates.push({ raffleId, prizeSentAt, payoutTxHash });
      }
    });

    for (const update of updates) {
      await this.pool.query(
        `UPDATE raffles
         SET prize_sent_at = COALESCE($1::timestamp, prize_sent_at),
             payout_tx_hash = COALESCE(NULLIF($2, ''), payout_tx_hash)
         WHERE id = $3`,
        [update.prizeSentAt || null, update.payoutTxHash || '', update.raffleId]
      );
    }
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

  async processQueue(targetSlotId = null) {
    if (!this.sheets || !this.pool || !this.queueSpreadsheetId) return;
    const normalizedTargetSlot = targetSlotId ? targetSlotId.toString().trim().toLowerCase() : null;

    try {
      console.log(`🔄 Checking Queue for slot: ${normalizedTargetSlot || 'ALL'}...`);
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
        console.warn('❌ Queue sheet missing slot_id or queue_position columns');
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
          console.log(`⚠️ [Queue] slot ${slotId}: NO ROWS IN QUEUE SHEET — add items to the queue sheet for this slot`);
          continue;
        }

        const activeRes = await this.pool.query(
          "SELECT id FROM raffles WHERE slot_id = $1 AND status IN ('TNM','LIVE','DRAW_PENDING')",
          [slotId]
        );
        if (activeRes.rows.length > 0) {
          console.log(`ℹ️ Slot ${slotId} already has active raffle (count=${activeRes.rows.length}), skipping`);
          continue;
        }

        // Always use queue_position = 1 — bot guarantees this is always a fresh raffle
        const pos1Row = slotRows.find(row => parseInt(row[queueIdx], 10) === 1);
        if (!pos1Row) {
          console.log(`⚠️ [Queue] slot ${slotId}: no queue_position=1 row found in sheet`);
          continue;
        }

        console.log(`📋 [Queue] slot ${slotId}: picking queue_position=1`);
        await this._createRaffleFromQueueRow(slotId, 1, pos1Row, headerMap);
      }
    } catch (err) {
      console.error('❌ Error processing queue:', err.message);
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
      await client.query('COMMIT');
      console.log(`✅ Created raffle for slot=${slotId} queue_position=1 (raffle id=${insertRes.rows[0].id})`);
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error creating raffle from queue row:', err.message);
      return false;
    } finally {
      client.release();
    }
  }

  async sync() {
    if (!this.sheets || !this.spreadsheetId || !this.pool) return;
    if (this._isSyncing) {
      console.log('⏭️ Ledger sync already in progress, skipping concurrent call');
      return;
    }
    this._isSyncing = true;
    try {
      console.log('🔄 Syncing Raffle Ledger...');
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.ledgerSheetName}'!A1:AD1000`,
      });
      const rows = res.data.values || [];
      if (rows.length === 0) {
        console.warn('⚠️ Ledger sheet is empty, cannot map headers');
        return;
      }

      const headerMap = this._mapHeaders(rows);
      await this._syncPayoutFieldsFromSheet(rows, headerMap);
      const dbResult = await this.pool.query("SELECT * FROM raffles ORDER BY id ASC");
      const raffles = dbResult.rows;

      // Normalize key: sheet headers may use spaces ("raffle id") or underscores ("raffle_id")
      const raffleIdCol = headerMap['raffle_id'] ?? headerMap['raffle id'];
      if (raffleIdCol === undefined) {
        console.error('❌ [Sync] Cannot find raffle_id column in sheet headers — aborting sync');
        return;
      }

      // Build map of raffle_id → sheet row number (1-indexed) from existing sheet data
      const existingRows = {};
      rows.forEach((row, i) => {
        const id = row[raffleIdCol];
        if (id && i > 0) existingRows[String(id)] = i + 1; // skip header row (i=0)
      });

      // Next free row is right after all currently read rows.
      // Using explicit row numbers instead of the sheets `append` API, which can
      // place data at wrong positions when leading columns in a row are empty.
      let nextRow = rows.length + 1;

      const batchData = [];

      for (const r of raffles) {
        const rowData = [];
        Object.keys(headerMap).forEach(key => {
          const idx = headerMap[key];
          const normalizedKey = (key || '').toString().toLowerCase().replace(/\s+/g, '_');
          let val = undefined;

          if (normalizedKey.includes('raffle_id')) {
            val = r.id;
          } else if (normalizedKey.includes('slot_id')) {
            val = r.slot_id;
          } else if (normalizedKey.includes('raffle_title')) {
            val = r.title;
          } else if (normalizedKey.includes('raffle_description')) {
            val = r.prize_description;
          } else if (normalizedKey.includes('novelty_name')) {
            val = r.novelty_name;
          } else if (normalizedKey.includes('partner')) {
            val = r.partner;
          } else if (normalizedKey.includes('campaign')) {
            val = r.campaign;
          } else if (normalizedKey.includes('prize_type')) {
            val = r.prize_type;
          } else if (normalizedKey.includes('prize_asset')) {
            val = r.prize_asset;
          } else if (normalizedKey.includes('prize_value_usd')) {
            val = r.prize_value_usd;
          } else if (normalizedKey.includes('points_per_ticket')) {
            val = r.points_per_ticket;
          } else if (normalizedKey.includes('threshold_points')) {
            val = r.threshold_points;
          } else if (normalizedKey.includes('threshold_users')) {
            val = r.threshold_participants;
          } else if (normalizedKey.includes('countdown_hours')) {
            val = r.countdown_hours;
          } else if (normalizedKey.includes('raffle_state') || normalizedKey.includes('raffle_status')) {
            val = this._mapStatus(r.status);
          } else if (normalizedKey.includes('raffle_created_at')) {
            val = this._fmtTs(r.created_at);
          } else if (normalizedKey.includes('tnm_completed_at')) {
            val = this._fmtTs(r.live_at);
          } else if (normalizedKey.includes('winner_drawn_at')) {
            val = this._fmtTs(r.ends_at);
          } else if (normalizedKey.includes('prize_sent_at')) {
            val = this._fmtTs(r.prize_sent_at);
          } else if (normalizedKey.includes('payout_tx_hash')) {
            val = r.payout_tx_hash;
          } else if (normalizedKey.includes('winner_wallet') || normalizedKey.includes('winner_address')) {
            val = r.winner_wallet;
          } else if (normalizedKey.includes('winner_ticket') || normalizedKey.includes('tickets_bought')) {
            val = r.winner_tickets;
          } else if (normalizedKey.includes('unique_participants')) {
            val = r.unique_participants;
          } else if (normalizedKey.includes('total_points_committed')) {
            val = r.total_points_committed;
          } else if (normalizedKey.includes('total_tickets_at_draw') || normalizedKey.includes('total_tickets')) {
            val = r.total_tickets;
          } else if (normalizedKey.includes('draw_block_number')) {
            val = r.draw_block;
          } else if (normalizedKey.includes('draw_block_hash')) {
            val = r.draw_block_hash;
          } else if (normalizedKey.includes('winning_ticket_number') || normalizedKey.includes('winning_ticket')) {
            val = r.winning_ticket;
          } else if (normalizedKey.includes('source_of_randomness')) {
            val = r.draw_block ? `Berachain block ${r.draw_block}` : '';
          }

          if (val !== undefined) {
            rowData[idx] = val === null ? '' : val;
          }
        });

        const rowNum = existingRows[String(r.id)];
        if (rowNum) {
          batchData.push({ range: `'${this.ledgerSheetName}'!A${rowNum}`, values: [rowData] });
        } else {
          batchData.push({ range: `'${this.ledgerSheetName}'!A${nextRow}`, values: [rowData] });
          existingRows[String(r.id)] = nextRow;
          nextRow++;
        }
      }

      // Send all updates in a single API call to avoid per-request quota exhaustion
      if (batchData.length > 0) {
        await this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: batchData,
          },
        });
      }
      console.log(`✅ Ledger sync complete (${batchData.length} rows)`);
    } catch (err) {
      console.error('❌ Error syncing ledger:', err.message);
    } finally {
      this._isSyncing = false;
    }
  }
}

module.exports = new RaffleSheetService();
