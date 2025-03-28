import fs from 'fs';
import path from 'path';

class Logger {
    private logFile: string;
    private writeStream: fs.WriteStream;

    constructor() {
        // Zorg ervoor dat de logs directory bestaat
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
        }

        this.logFile = path.join(logsDir, 'sessie.log');
        
        // Verwijder het bestaande log bestand als het bestaat
        if (fs.existsSync(this.logFile)) {
            fs.unlinkSync(this.logFile);
        }

        // Maak een nieuwe write stream
        this.writeStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    }

    log(message: string) {
        // Schrijf naar console
        console.log(message);
        
        // Schrijf naar bestand met timestamp
        const timestamp = new Date().toISOString();
        this.writeStream.write(`${timestamp} - ${message}\n`);
    }

    error(message: string) {
        // Schrijf naar console
        console.error(message);
        
        // Schrijf naar bestand met timestamp
        const timestamp = new Date().toISOString();
        this.writeStream.write(`${timestamp} - ERROR: ${message}\n`);
    }

    close() {
        this.writeStream.end();
    }
}

// Export een singleton instance
export const logger = new Logger(); 