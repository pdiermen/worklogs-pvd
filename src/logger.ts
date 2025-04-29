import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Maak de logs directory aan als deze niet bestaat
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Maak het log bestand leeg bij elke herstart
const logFile = path.join(logDir, 'app.log');
if (fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '');
}

const winstonLogger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ 
            filename: logFile,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...metadata }) => {
                    let msg = `${timestamp} [${level}] : ${message}`;
                    if (Object.keys(metadata).length > 0) {
                        msg += ` ${JSON.stringify(metadata)}`;
                    }
                    return msg;
                })
            )
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Handle uncaught exceptions and unhandled rejections
winstonLogger.exceptions.handle(
    new winston.transports.File({ filename: 'exceptions.log' })
);

winstonLogger.rejections.handle(
    new winston.transports.File({ filename: 'rejections.log' })
);

// Compatibiliteitslaag voor de oude logger interface
export const logger = {
    log: (message: string, metadata?: any) => {
        winstonLogger.info(message, metadata);
    },
    error: (message: string, metadata?: any) => {
        winstonLogger.error(message, metadata);
    }
}; 