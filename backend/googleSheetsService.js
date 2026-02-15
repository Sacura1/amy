const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const database = require('./database');

/**
 * Google Sheets Service for Leaderboard Data
 *
 * This service fetches leaderboard data from a Google Spreadsheet
 * Columns expected: position/rank, username, mindshare, profileimage
 * Note: profileimage is ignored as we fetch from X directly
 */

class GoogleSheetsService {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    this.range = process.env.GOOGLE_SHEETS_RANGE || 'Sheet1!A2:D'; // Default range, skip header row
  }

  /**
   * Initialize Google Sheets API client
   * Supports both API Key and Service Account authentication
   */
  async initialize() {
    try {
      // Method 1: API Key (simpler, read-only access to public sheets)
      if (process.env.GOOGLE_SHEETS_API_KEY) {
        this.sheets = google.sheets({
          version: 'v4',
          auth: process.env.GOOGLE_SHEETS_API_KEY
        });
        console.log('✅ Google Sheets initialized with API Key');
        return true;
      }

      // Method 2: Service Account (more secure, works with private sheets)
      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        const auth = new google.auth.GoogleAuth({
          credentials: serviceAccountKey,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });

        this.sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets initialized with Service Account');
        return true;
      }

      // Method 3: Service Account from file (for local development)
      const serviceAccountPath = path.join(__dirname, 'google-service-account.json');
      if (fs.existsSync(serviceAccountPath)) {
        const auth = new google.auth.GoogleAuth({
          keyFile: serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });

        this.sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets initialized with Service Account file');
        return true;
      }

      console.error('❌ No Google Sheets authentication method found');
      console.log('Please set either:');
      console.log('  - GOOGLE_SHEETS_API_KEY (for public sheets)');
      console.log('  - GOOGLE_SERVICE_ACCOUNT_KEY (JSON string)');
      console.log('  - Or create google-service-account.json file');
      return false;
    } catch (error) {
      console.error('❌ Error initializing Google Sheets:', error.message);
      return false;
    }
  }

  /**
   * Fetch leaderboard data from Google Sheets
   * @returns {Promise<Array>} Array of leaderboard entries
   */
  async fetchLeaderboardData() {
    try {
      if (!this.sheets) {
        const initialized = await this.initialize();
        if (!initialized) {
          throw new Error('Google Sheets not initialized');
        }
      }

      if (!this.spreadsheetId) {
        throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID not configured');
      }

      console.log(`📊 Fetching leaderboard from sheet: ${this.spreadsheetId}`);
      console.log(`📍 Range: ${this.range}`);

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.range,
      });

      const rows = response.data.values;

      if (!rows || rows.length === 0) {
        console.log('⚠️  No data found in spreadsheet');
        return [];
      }

      console.log(`📥 Found ${rows.length} rows in spreadsheet`);

      // Transform spreadsheet rows to leaderboard format
      // Expected columns: position/rank, username, mindshare, profileimage (ignored)
      const leaderboardData = rows
        .map((row, index) => {
          try {
            // Handle different column formats
            const position = parseInt(row[0]) || (index + 1);
            const xUsername = (row[1] || '').trim().replace('@', ''); // Remove @ if present
            const mindshare = row[2] ? parseFloat(row[2]) : undefined;

            // Skip rows with invalid data
            if (!xUsername) {
              console.warn(`⚠️  Row ${index + 2} skipped: missing username`);
              return null;
            }

            const entry = {
              position,
              xUsername
            };

            // Only add mindshare if it's a valid number
            if (mindshare !== undefined && !isNaN(mindshare)) {
              entry.mindshare = mindshare;
            }

            return entry;
          } catch (error) {
            console.error(`❌ Error parsing row ${index + 2}:`, error.message);
            return null;
          }
        })
        .filter(entry => entry !== null); // Remove invalid entries

      console.log(`✅ Successfully parsed ${leaderboardData.length} leaderboard entries`);

      // Log a sample of the data for verification
      if (leaderboardData.length > 0) {
        console.log('📋 Sample entry:', JSON.stringify(leaderboardData[0], null, 2));
      }

      return leaderboardData;
    } catch (error) {
      console.error('❌ Error fetching from Google Sheets:', error.message);
      throw error;
    }
  }

  /**
   * Update local leaderboard.json file with data from Google Sheets
   * @param {string} leaderboardPath - Path to leaderboard.json file
   */
  async updateLeaderboardFile(leaderboardPath) {
    try {
      console.log('\n🔄 Starting leaderboard update from Google Sheets...');

      const leaderboardData = await this.fetchLeaderboardData();

      if (leaderboardData.length === 0) {
        console.warn('⚠️  No data fetched, keeping existing leaderboard');
        return false;
      }

      // Read current leaderboard to preserve other fields
      let currentData = {
        leaderboard: [],
        lastUpdated: new Date().toISOString(),
        minimumAMY: 300
      };

      if (fs.existsSync(leaderboardPath)) {
        try {
          const existingData = JSON.parse(fs.readFileSync(leaderboardPath, 'utf8'));
          currentData.minimumAMY = existingData.minimumAMY || 300;
        } catch (error) {
          console.warn('⚠️  Could not read existing leaderboard, creating new one');
        }
      }

      // Update with new data
      currentData.leaderboard = leaderboardData;
      currentData.lastUpdated = new Date().toISOString();

      // Create backup of old file
      if (fs.existsSync(leaderboardPath)) {
        const backupPath = leaderboardPath.replace('.json', `.backup.${Date.now()}.json`);
        fs.copyFileSync(leaderboardPath, backupPath);
        console.log(`💾 Backup created: ${path.basename(backupPath)}`);
      }

      // Write updated data to JSON file
      fs.writeFileSync(leaderboardPath, JSON.stringify(currentData, null, 2));
      console.log(`✅ JSON file updated successfully!`);

      // Also update PostgreSQL database if available
      try {
        if (database.leaderboard) {
          await database.leaderboard.update(currentData);
          console.log(`✅ PostgreSQL database updated successfully!`);
        } else {
          console.log(`ℹ️  PostgreSQL not available, using JSON file only`);
        }
      } catch (dbError) {
        console.error('⚠️  Failed to update PostgreSQL database:', dbError.message);
        console.log('✅ JSON file updated, but database update failed');
        // Don't throw - JSON file is still updated
      }

      console.log(`📊 Total entries: ${leaderboardData.length}`);
      console.log(`🕒 Last updated: ${currentData.lastUpdated}`);

      return true;
    } catch (error) {
      console.error('❌ Error updating leaderboard file:', error.message);
      throw error;
    }
  }
}

module.exports = new GoogleSheetsService();
