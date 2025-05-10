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

export interface ProjectConfig {
    projectName: string;
    projectCodes: string[];
    jqlFilter: string;
    worklogName: string;
    worklogJql: string;
}

export async function getProjectConfigsFromSheet(): Promise<ProjectConfig[]> {
    try {
        logger.log('Start ophalen van project configuraties uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Projects!A2:E', // Aangepast naar A2:E om ook de worklogJql kolom op te halen
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen project configuraties gevonden in Google Sheet');
            throw new Error('Geen project configuraties gevonden in Google Sheet');
        }

        const configs: ProjectConfig[] = [];
        rows.forEach((row, index) => {
            const [projectName, projectCodes, jqlFilter, worklogName, worklogJql] = row;
            if (projectName && projectCodes) {
                configs.push({
                    projectName,
                    projectCodes: projectCodes.split(',').map((code: string) => code.trim()),
                    jqlFilter: jqlFilter || '',
                    worklogName: worklogName || '',
                    worklogJql: worklogJql || ''
                });
                logger.log(`Project configuratie voor ${projectName}:`);
                logger.log(`- WorklogJql: ${worklogJql || 'geen'}`);
            }
        });

        logger.log(`${configs.length} project configuraties gevonden in Google Sheet`);
        return configs;
    } catch (error: any) {
        logger.error(`Error bij ophalen van project configuraties uit Google Sheet: ${error.message}`);
        throw error;
    }
}

export interface WorklogConfig {
    worklogName: string;
    columnName: string;
    issues: string[];
    projectName?: string;
}

export async function getWorklogConfigsFromSheet(): Promise<WorklogConfig[]> {
    try {
        logger.log('Start ophalen van worklog configuraties uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Worklogs!A2:C', // Aangepast naar A2:C om ook de issues kolom op te halen
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen worklog configuraties gevonden in Google Sheet');
            throw new Error('Geen worklog configuraties gevonden in Google Sheet');
        }

        const configs: WorklogConfig[] = [];
        rows.forEach((row, index) => {
            const [worklogName, columnName, issues] = row;
            if (worklogName && columnName) {
                configs.push({
                    projectName: worklogName || '',
                    worklogName,
                    columnName,
                    issues: issues ? issues.split(',').map((issue: string) => issue.trim()) : []
                });
            }
        });

        logger.log(`${configs.length} worklog configuraties gevonden in Google Sheet`);
        return configs;
    } catch (error: any) {
        logger.error(`Error bij ophalen van worklog configuraties uit Google Sheet: ${error.message}`);
        throw error;
    }
}

export async function getGoogleSheetsData() {
  try {
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: 'Employees!A1:H',
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      logger.error('Geen data gevonden in Resources sheet');
      throw new Error('Geen data gevonden in Resources sheet');
    }

    // Valideer de verplichte kolommen
    const headerRow = rows[0];
    const nameIndex = 2; // Kolom C (Naam)
    const projectIndex = 7; // Kolom H (Project)
    const effectiveHoursIndex = 6; // Kolom G (Effectieve uren)

    // Controleer of de headers overeenkomen met wat we verwachten
    if (headerRow[nameIndex] !== 'Naam' || headerRow[projectIndex] !== 'Project' || headerRow[effectiveHoursIndex] !== 'Effectieve uren') {
      logger.error(`Verkeerde kolom headers in Employees sheet. Verwacht: Naam (C), Project (H), Effectieve uren (G)`);
      throw new Error(`Verkeerde kolom headers in Employees sheet`);
    }

    return rows;
  } catch (error) {
    logger.error(`Error bij ophalen van Resources sheet data: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
} 