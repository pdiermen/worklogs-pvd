import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

// Check required environment variables
const requiredEnvVars = ['GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY', 'GOOGLE_SHEETS_SPREADSHEET_ID'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        const error = new Error(`Missing required environment variable: ${envVar}`);
        logger.error(error.message);
        throw error;
    }
}

// Configureer Google Sheets API
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

export interface SprintCapacity {
    assignee: string;
    capacity: number;
    sprintId: number;
}

export async function getSprintCapacityFromSheet(): Promise<SprintCapacity[]> {
    try {
        logger.log('Start ophalen van sprint capaciteit uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Sprint Capacity!A2:C', // Pas dit aan naar het juiste bereik in je sheet
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen data gevonden in Google Sheet');
            throw new Error('Geen data gevonden in Google Sheet');
        }

        const capacities: SprintCapacity[] = [];
        rows.forEach((row, index) => {
            const [assignee, capacity, sprintId] = row;
            if (assignee && capacity && sprintId) {
                capacities.push({
                    assignee,
                    capacity: parseInt(capacity, 10),
                    sprintId: parseInt(sprintId, 10)
                });
            }
        });

        logger.log(`${capacities.length} sprint capaciteiten gevonden in Google Sheet`);
        return capacities;
    } catch (error: any) {
        logger.error(`Error bij ophalen van sprint capaciteit uit Google Sheet: ${error.message}`);
        throw error;
    }
} 