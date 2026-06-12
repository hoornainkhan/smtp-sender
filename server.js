const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for simplicity
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}-${file.originalname}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    },
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

// Store active sending jobs
const activeJobs = new Map();

// Create transporter with or without proxy
function createTransporter(smtpConfig, proxyConfig = null) {
    const config = {
        host: smtpConfig.host,
        port: parseInt(smtpConfig.port),
        secure: smtpConfig.encryption === 'ssl',
        requireTLS: smtpConfig.encryption === 'tls',
        auth: {
            user: smtpConfig.username,
            pass: smtpConfig.password
        },
        tls: {
            rejectUnauthorized: false
        },
        connectionTimeout: parseInt(smtpConfig.timeout || 30000),
        greetingTimeout: parseInt(smtpConfig.timeout || 30000),
        socketTimeout: parseInt(smtpConfig.timeout || 30000),
        pool: true,
        maxConnections: 20,
        maxMessages: Infinity
    };

    if (proxyConfig && proxyConfig.host) {
        try {
            const proxyUrl = proxyConfig.auth 
                ? `${proxyConfig.protocol}://${proxyConfig.auth.user}:${proxyConfig.auth.pass}@${proxyConfig.host}:${proxyConfig.port}`
                : `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`;
            
            if (proxyConfig.protocol === 'socks5' || proxyConfig.protocol === 'socks4') {
                const SocksProxyAgent = require('socks-proxy-agent');
                config.agent = new SocksProxyAgent(proxyUrl);
            } else {
                const HttpsProxyAgent = require('https-proxy-agent');
                config.agent = new HttpsProxyAgent(proxyUrl);
            }
        } catch (error) {
            console.error('Proxy configuration error:', error);
        }
    }

    return nodemailer.createTransport(config);
}

// Parse proxy string
function parseProxy(proxyString) {
    try {
        const proxyRegex = /^(socks5|socks4|http|https):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/;
        const match = proxyString.match(proxyRegex);
        
        if (!match) return null;
        
        return {
            protocol: match[1],
            auth: match[2] && match[3] ? { user: decodeURIComponent(match[2]), pass: decodeURIComponent(match[3]) } : null,
            host: match[4],
            port: parseInt(match[5])
        };
    } catch (error) {
        return null;
    }
}

// Send single email
async function sendEmail(transporter, mailOptions) {
    try {
        const info = await transporter.sendMail(mailOptions);
        return {
            success: true,
            messageId: info.messageId,
            response: info.response
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// Test SMTP connection
app.post('/api/test-connection', async (req, res) => {
    try {
        const { smtpConfig, proxyConfig } = req.body;
        
        if (!smtpConfig.host || !smtpConfig.username || !smtpConfig.password) {
            return res.status(400).json({
                success: false,
                message: 'Missing required SMTP configuration'
            });
        }
        
        const transporter = createTransporter(smtpConfig, proxyConfig);
        const verified = await transporter.verify();
        transporter.close();
        
        if (verified) {
            res.json({
                success: true,
                message: 'SMTP connection successful',
                details: { host: smtpConfig.host, port: smtpConfig.port, encryption: smtpConfig.encryption }
            });
        } else {
            res.json({
                success: false,
                message: 'SMTP connection failed - verification returned false'
            });
        }
    } catch (error) {
        res.status(400).json({
            success: false,
            message: `Connection failed: ${error.message}`
        });
    }
});

// Start bulk sending
app.post('/api/send-bulk', async (req, res) => {
    try {
        const { smtpConfig, recipients, ccRecipients, bccRecipients, emailContent, sendingOptions, proxyList } = req.body;

        if (!smtpConfig || !recipients || !emailContent) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        if (!Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No recipients provided'
            });
        }

        const jobId = uuidv4();
        
        const job = {
            id: jobId,
            status: 'running',
            startedAt: new Date(),
            stats: {
                total: recipients.length,
                sent: 0,
                failed: 0,
                remaining: recipients.length
            },
            logs: [],
            stopRequested: false
        };
        
        activeJobs.set(jobId, job);
        
        res.json({
            success: true,
            jobId: jobId,
            message: `Bulk sending started for ${recipients.length} recipients`
        });

        processBulkSend(jobId, smtpConfig, recipients, ccRecipients, bccRecipients, 
                        emailContent, sendingOptions, proxyList).catch(error => {
            console.error(`Job ${jobId} failed:`, error);
            const job = activeJobs.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = error.message;
            }
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Process bulk sending
async function processBulkSend(jobId, smtpConfig, recipients, ccRecipients, bccRecipients, 
                               emailContent, sendingOptions, proxyList) {
    const job = activeJobs.get(jobId);
    if (!job) return;

    try {
        const delay = parseInt(sendingOptions?.delay || 1) * 1000;
        const batchSize = parseInt(sendingOptions?.batchSize || 10);
        const maxRetries = parseInt(sendingOptions?.maxRetries || 3);
        const threads = parseInt(sendingOptions?.threads || 5);

        let transporters = new Map();

        for (let i = 0; i < recipients.length; i += batchSize) {
            if (job.stopRequested) {
                job.logs.push({
                    timestamp: new Date(),
                    type: 'info',
                    message: '⏹️ Bulk sending stopped by user'
                });
                break;
            }

            const batch = recipients.slice(i, i + batchSize);
            
            const promises = batch.map(async (recipient, batchIndex) => {
                if (job.stopRequested) return null;

                try {
                    let transporterKey = 'default';
                    let proxyIndex = i + batchIndex;
                    
                    if (proxyList && proxyList.length > 0) {
                        const proxyString = getNextProxy(proxyList, sendingOptions.proxyRotation, proxyIndex);
                        transporterKey = proxyString;
                        
                        if (!transporters.has(transporterKey)) {
                            const proxyConfig = parseProxy(proxyString);
                            if (proxyConfig) {
                                transporters.set(transporterKey, createTransporter(smtpConfig, proxyConfig));
                            }
                        }
                    } else if (!transporters.has('default')) {
                        transporters.set('default', createTransporter(smtpConfig));
                    }
                    
                    const transporter = transporters.get(transporterKey);
                    if (!transporter) {
                        throw new Error('Failed to create transporter');
                    }
                    
                    const mailOptions = {
                        from: emailContent.fromName 
                            ? `"${emailContent.fromName}" <${emailContent.fromEmail || smtpConfig.username}>`
                            : emailContent.fromEmail || smtpConfig.username,
                        to: recipient,
                        subject: emailContent.subject,
                        text: emailContent.contentType === 'text' ? emailContent.messageBody : undefined,
                        html: emailContent.contentType === 'html' ? emailContent.messageBody : undefined,
                        headers: {
                            'X-Mailer': 'SMTP Bulk Sender',
                            'X-Priority': '3'
                        }
                    };

                    if (ccRecipients && ccRecipients.length > 0) {
                        mailOptions.cc = ccRecipients.join(', ');
                    }
                    if (bccRecipients && bccRecipients.length > 0) {
                        mailOptions.bcc = bccRecipients.join(', ');
                    }
                    if (emailContent.attachments && emailContent.attachments.length > 0) {
                        mailOptions.attachments = emailContent.attachments.map(att => ({
                            filename: att.filename,
                            path: att.path,
                            contentType: att.contentType
                        }));
                    }

                    let lastError;
                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                        if (job.stopRequested) break;
                        
                        try {
                            const result = await sendEmail(transporter, mailOptions);
                            if (result.success) {
                                job.stats.sent++;
                                job.stats.remaining = job.stats.total - job.stats.sent - job.stats.failed;
                                job.logs.push({
                                    timestamp: new Date(),
                                    type: 'success',
                                    message: `✅ Sent to ${recipient}`
                                });
                                return { success: true, recipient };
                            } else {
                                lastError = result.error;
                            }
                        } catch (error) {
                            lastError = error.message;
                        }
                        
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                        }
                    }
                    
                    throw new Error(lastError || 'Max retries exceeded');
                    
                } catch (error) {
                    job.stats.failed++;
                    job.stats.remaining = job.stats.total - job.stats.sent - job.stats.failed;
                    job.logs.push({
                        timestamp: new Date(),
                        type: 'error',
                        message: `❌ Failed to send to ${recipient}: ${error.message}`
                    });
                    return { success: false, recipient, error: error.message };
                }
            });

            const chunks = [];
            for (let j = 0; j < promises.length; j += threads) {
                chunks.push(promises.slice(j, j + threads));
            }
            
            for (const chunk of chunks) {
                if (job.stopRequested) break;
                await Promise.allSettled(chunk);
            }

            if (i + batchSize < recipients.length && !job.stopRequested) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        for (const transporter of transporters.values()) {
            transporter.close();
        }

        job.status = job.stopRequested ? 'stopped' : 'completed';
        job.completedAt = new Date();
        job.logs.push({
            timestamp: new Date(),
            type: 'info',
            message: `📊 Bulk sending ${job.status}. Sent: ${job.stats.sent}, Failed: ${job.stats.failed}`
        });

    } catch (error) {
        job.status = 'error';
        job.error = error.message;
        job.logs.push({
            timestamp: new Date(),
            type: 'error',
            message: `💥 Fatal error: ${error.message}`
        });
    }
}

function getNextProxy(proxyList, rotation, currentIndex) {
    if (!proxyList || proxyList.length === 0) return null;
    
    switch (rotation) {
        case 'random':
            return proxyList[Math.floor(Math.random() * proxyList.length)];
        case 'roundrobin':
            return proxyList[currentIndex % proxyList.length];
        default:
            return proxyList[currentIndex % proxyList.length];
    }
}

// Get job status
app.get('/api/job-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = activeJobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({
            success: false,
            message: 'Job not found'
        });
    }

    res.json({
        success: true,
        job: {
            id: job.id,
            status: job.status,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            stats: job.stats,
            logs: job.logs.slice(-100)
        }
    });
});

// Stop job
app.post('/api/stop-job/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = activeJobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({
            success: false,
            message: 'Job not found'
        });
    }

    job.stopRequested = true;
    res.json({
        success: true,
        message: 'Stop requested'
    });
});

// Upload attachments
app.post('/api/upload-attachments', upload.array('attachments', 20), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }

        const files = req.files.map(file => ({
            filename: file.originalname,
            path: file.path,
            contentType: file.mimetype,
            size: file.size
        }));

        res.json({
            success: true,
            files: files
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// Clean up old jobs
setInterval(() => {
    const now = new Date();
    for (const [jobId, job] of activeJobs.entries()) {
        if (job.completedAt && (now - job.completedAt) > 3600000) {
            activeJobs.delete(jobId);
        }
    }
}, 300000);

// Catch-all route to serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🚀 SMTP Bulk Email Sender');
    console.log('='.repeat(50));
    console.log(`📡 Server running at: http://localhost:${PORT}`);
    console.log(`🌐 Open your browser and navigate to: http://localhost:${PORT}`);
    console.log(`📧 Ready to send bulk emails`);
    console.log('='.repeat(50));
});