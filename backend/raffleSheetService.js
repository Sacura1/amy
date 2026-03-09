const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

/**
 * Raffle Ledger — Google Sheets Sync Service
 *
 * Syncs raffle data from PostgreSQL to a Google Sheet (Amy_Raffle_Ledger_v3).
 * Appends new raffles, updates existing rows by raffle_id.
 *
 * Column layout:
 *   A: raffle_id                                        ← backend
 *   B: partner               C: campaign                ← MANUAL (not in DB)
 *   D: raffle_title          E: raffle_description      ← backend
 *   F: prize_type  G: prize_asset  H: prize_value_usd   ← MANUAL (not in DB)
 *   I: points_per_ticket     J: threshold_points        ← backend
 *   K: threshold_users       L: countdown_hours         ← backend
 *   M: raffle_created_at     N: tnm_completed_at        ← backend
 *   O: winner_drawn_at       P: raffle_state            ← backend
 *   Q: draw_block_number     R: draw_block_hash         ← backend
 *   S: source_of_randomness  T: winning_ticket_number   ← backend
 *   U: winner_ticket_count   V: total_tickets_at_draw   ← backend
 *   W: unique_participants   X: total_points_committed  ← backend
 *   Y: winner_wallet                                    ← backend
 *   Z–AC: formula columns (DO NOT WRITE)
 *   AD–AG: manual payout columns (DO NOT WRITE)
 *
 * The backend writes ONLY to columns it owns. Columns B, C, F, G, H
 * are left untouched so manual entries are preserved.
 */

class RaffleSheetService {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = process.env.RAFFLE_SHEET_SPREADSHEET_ID;
    this.sheetName = process.env.RAFFLE_SHEET_NAME || 'Sheet1';
    this.pool = null;
  }

  /**
   * Initialize with a pg Pool and authenticate to Google Sheets (read+write)
   */
  async initialize(pool) {
    this.pool = pool;

    try {
      // Service Account from env var (Railway / production)
      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        const auth = new google.auth.GoogleAuth({
          credentials: creds,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Raffle Sheet Service initialized (service account env)');
        return true;
      }

      // Service Account from file (local dev)
      const saPath = path.join(__dirname, 'google-service-account.json');
      if (fs.existsSync(saPath)) {
        const auth = new google.auth.GoogleAuth({
          keyFile: saPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Raffle Sheet Service initialized (service account file)');
        return true;
      }

      console.warn('⚠️  Raffle Sheet Service: no credentials found — sync disabled');
      return false;
    } catch (err) {
      console.error('❌ Raffle Sheet Service init error:', err.message);
      return false;
    }
  }

  // ─── helpers ──────────────────────────────────────────────

  _fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  _mapStatus(s) {
    if (s === 'COMPLETED') return 'DRAWN';
    if (s === 'DRAW_PENDING') return 'DRAW_PENDING';
    return s; // TNM, LIVE, CANCELLED
  }

  /** Read all existing raffle_id values from col A → Map<id_string, rowNumber> */
  async _getExistingRows() {
    const range = `${this.sheetName}!A2:A`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    const rows = res.data.values || [];
    const map = new Map();
    rows.forEach((r, i) => {
      if (r[0]) map.set(String(r[0]), i + 2); // +2: row 1 = header, 0-based array
    });
    return map;
  }

  /**
   * Build per-range update data for a single row.
   * Writes only backend-owned columns, skipping B, C, F, G, H.
   * Returns array of { range, values } for batchUpdate.
   */
  _buildRanges(row, r, winnerTicketCount, winnerDrawnAt) {
    const sn = this.sheetName;
    return [
      // A: raffle_id
      { range: `${sn}!A${row}`, values: [[r.id]] },
      // D–E: raffle_title, raffle_description (skip B, C)
      { range: `${sn}!D${row}:E${row}`, values: [[r.title || '', r.prize_description || '']] },
      // I–Y: all backend-owned columns from points_per_ticket onward (skip F, G, H)
      {
        range: `${sn}!I${row}:Y${row}`,
        values: [[
          /* I  */ r.ticket_cost ?? 50,
          /* J  */ 5000,                                             // threshold_points
          /* K  */ 10,                                               // threshold_users
          /* L  */ r.countdown_hours || '',
          /* M  */ this._fmtTs(r.created_at),
          /* N  */ this._fmtTs(r.live_at),                           // tnm_completed_at
          /* O  */ winnerDrawnAt,
          /* P  */ this._mapStatus(r.status),
          /* Q  */ r.draw_block != null ? Number(r.draw_block) : '',
          /* R  */ r.draw_block_hash || '',
          /* S  */ r.draw_block_hash ? 'Berachain block hash' : '',
          /* T  */ r.winning_ticket != null ? Number(r.winning_ticket) : '',
          /* U  */ winnerTicketCount ?? '',
          /* V  */ r.total_tickets_at_draw != null ? Number(r.total_tickets_at_draw) : '',
          /* W  */ r.unique_participants || '',
          /* X  */ r.total_points_committed || '',
          /* Y  */ r.winner_wallet || '',
        ]],
      },
    ];
  }

  // ─── main sync ─────────────────────────────────────────────

  async sync() {
    if (!this.sheets || !this.spreadsheetId || !this.pool) {
      console.log('⏭️  Raffle sheet sync skipped (not configured)');
      return;
    }

    try {
      console.log('🔄 Raffle sheet sync starting…');

      // 1. Fetch all raffles from DB
      const dbResult = await this.pool.query(`SELECT * FROM raffles ORDER BY id ASC`);
      const raffles = dbResult.rows;

      if (!raffles.length) {
        console.log('ℹ️  No raffles in DB');
        return;
      }

      // 2. Get winner ticket counts for completed raffles
      const winnerCounts = new Map();
      const completedWithWinner = raffles.filter((r) => r.status === 'COMPLETED' && r.winner_wallet);

      if (completedWithWinner.length) {
        // Join each raffle to its winner's entry row
        const ids = completedWithWinner.map((r) => r.id);
        const entriesResult = await this.pool.query(
          `SELECT re.raffle_id, re.tickets
           FROM raffle_entries re
           JOIN raffles r ON r.id = re.raffle_id
           WHERE re.raffle_id = ANY($1)
             AND LOWER(re.wallet) = LOWER(r.winner_wallet)`,
          [ids]
        );
        for (const row of entriesResult.rows) {
          winnerCounts.set(row.raffle_id, parseInt(row.tickets));
        }
      }

      // 3. Read existing sheet rows (raffle_id → row number)
      const existingRows = await this._getExistingRows();

      // 4. Read existing winner_drawn_at values to preserve them
      const winnerDrawnAtMap = new Map();
      if (existingRows.size > 0) {
        try {
          const oRes = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: `${this.sheetName}!O2:O`,
          });
          const oRows = oRes.data.values || [];
          oRows.forEach((oRow, i) => {
            winnerDrawnAtMap.set(i + 2, oRow[0] || '');
          });
        } catch (e) {
          // empty range is fine
        }
      }

      // 5. Build updates and appends
      const batchData = [];  // for batchUpdate (existing rows)
      const toAppend = [];   // for append (new rows)

      for (const raffle of raffles) {
        const idStr = String(raffle.id);
        const winnerTix = winnerCounts.get(raffle.id) ?? '';
        const existingRowNum = existingRows.get(idStr);

        // Resolve winner_drawn_at
        let winnerDrawnAt = '';
        if (existingRowNum) {
          winnerDrawnAt = winnerDrawnAtMap.get(existingRowNum) || '';
        }
        if (!winnerDrawnAt && raffle.status === 'COMPLETED') {
          winnerDrawnAt = this._fmtTs(new Date());
        }

        if (existingRowNum) {
          // Update existing row — only backend-owned columns
          const ranges = this._buildRanges(existingRowNum, raffle, winnerTix, winnerDrawnAt);
          batchData.push(...ranges);
        } else {
          // New raffle — full row A–Y (manual columns left blank for user to fill)
          toAppend.push([
            /* A  */ raffle.id,
            /* B  */ '',   // partner (manual)
            /* C  */ '',   // campaign (manual)
            /* D  */ raffle.title || '',
            /* E  */ raffle.prize_description || '',
            /* F  */ '',   // prize_type (manual)
            /* G  */ '',   // prize_asset (manual)
            /* H  */ '',   // prize_value_usd (manual)
            /* I  */ raffle.ticket_cost ?? 50,
            /* J  */ 5000,
            /* K  */ 10,
            /* L  */ raffle.countdown_hours || '',
            /* M  */ this._fmtTs(raffle.created_at),
            /* N  */ this._fmtTs(raffle.live_at),
            /* O  */ winnerDrawnAt,
            /* P  */ this._mapStatus(raffle.status),
            /* Q  */ raffle.draw_block != null ? Number(raffle.draw_block) : '',
            /* R  */ raffle.draw_block_hash || '',
            /* S  */ raffle.draw_block_hash ? 'Berachain block hash' : '',
            /* T  */ raffle.winning_ticket != null ? Number(raffle.winning_ticket) : '',
            /* U  */ winnerTix,
            /* V  */ raffle.total_tickets_at_draw != null ? Number(raffle.total_tickets_at_draw) : '',
            /* W  */ raffle.unique_participants || '',
            /* X  */ raffle.total_points_committed || '',
            /* Y  */ raffle.winner_wallet || '',
          ]);
        }
      }

      // 6. Batch update existing rows (skip manual columns)
      if (batchData.length) {
        await this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: batchData,
          },
        });
        const updatedCount = new Set(batchData.map((d) => d.range.match(/\d+/)?.[0])).size;
        console.log(`📝 Updated ${updatedCount} existing raffle row(s)`);
      }

      // 7. Append new rows at bottom
      if (toAppend.length) {
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!A:Y`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: toAppend },
        });
        console.log(`➕ Appended ${toAppend.length} new raffle row(s)`);
      }

      if (!batchData.length && !toAppend.length) {
        console.log('✅ Raffle sheet already up to date');
      } else {
        console.log('✅ Raffle sheet sync complete');
      }
    } catch (err) {
      console.error('❌ Raffle sheet sync error:', err.message);
    }
  }
}

module.exports = new RaffleSheetService();
