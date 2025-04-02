import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({
            filename: 'error.log',
            level: 'error'
        }),
        new winston.transports.File({
            filename: 'combined.log'
        })
    ]
});

// Handle uncaught exceptions and unhandled rejections
logger.exceptions.handle(
    new winston.transports.File({ filename: 'exceptions.log' })
);

logger.rejections.handle(
    new winston.transports.File({ filename: 'rejections.log' })
);

// Add log and error methods for compatibility with old logger
const compatLogger = {
    log: (message: string) => logger.info(message),
    error: (message: string) => logger.error(message)
};

export { compatLogger as logger }; 