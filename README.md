# Planning PvD

Een applicatie voor het beheren van projectplanning en resourceallocatie, geïntegreerd met Jira en Google Sheets.

## Functionaliteiten

- Automatische synchronisatie met Jira voor issue tracking
- Resource planning via Google Sheets
- Sprint capaciteitsbeheer
- Werklog tracking
- Project configuratie beheer
- Automatische planning van issues op basis van beschikbare capaciteit

## Technische Vereisten

- Node.js 18 of hoger
- NPM (Node Package Manager)
- Google Sheets API toegang
- Jira API toegang

## Installatie

1. Clone de repository:
```bash
git clone [repository-url]
cd Planning-PvD
```

2. Installeer dependencies:
```bash
npm install
```

3. Maak een `.env` bestand aan met de volgende variabelen:
```env
JIRA_HOST=your-jira-host
JIRA_USERNAME=your-jira-username
JIRA_API_TOKEN=your-jira-api-token
GOOGLE_SHEETS_CLIENT_EMAIL=your-google-sheets-client-email
GOOGLE_SHEETS_PRIVATE_KEY=your-google-sheets-private-key
GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id
```

## Gebruik

### Development Server Starten
```bash
npm run dev
```

### Productie Build
```bash
npm run build
npm start
```

## Google Sheets Configuratie

De applicatie verwacht de volgende sheets in de Google Spreadsheet:

1. **Employees**: Bevat medewerker informatie
   - Kolommen: Naam, Beschikbare uren, etc.

2. **SprintCapacity**: Bevat sprint capaciteit informatie
   - Kolommen: Sprint, Medewerker, Beschikbare uren

3. **ProjectConfig**: Bevat project configuratie
   - Kolommen: Project naam, Configuratie details

4. **WorklogConfig**: Bevat werklog configuratie
   - Kolommen: Configuratie voor werklog tracking

## Jira Integratie

De applicatie synchroniseert met Jira voor:
- Issue tracking
- Werklog registratie
- Sprint planning
- Project status updates

## Licentie

[Voeg hier de licentie informatie toe] 