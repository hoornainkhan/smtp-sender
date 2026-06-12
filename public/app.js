// ============================================
// SMTP Bulk Sender - Complete Application
// ============================================

// State management
let isSending = false;
let shouldStop = false;
let currentJobId = null;
let statusPollingInterval = null;
let logs = [];
let stats = { total: 0, sent: 0, failed: 0, remaining: 0 };
let smtpConfigs = [];

// ============================================
// SMTP Provider Presets
// ============================================
const smtpPresets = {
    office365: { host: 'smtp.office365.com', port: '587', encryption: 'tls' },
    gmail: { host: 'smtp.gmail.com', port: '587', encryption: 'tls' },
    icloud: { host: 'smtp.mail.me.com', port: '587', encryption: 'tls' },
    yahoo: { host: 'smtp.mail.yahoo.com', port: '587', encryption: 'tls' },
    outlook: { host: 'smtp-mail.outlook.com', port: '587', encryption: 'tls' },
    zoho: { host: 'smtp.zoho.com', port: '587', encryption: 'tls' },
    sendgrid: { host: 'smtp.sendgrid.net', port: '587', encryption: 'tls' },
    rambler: { host: 'smtp.rambler.ru', port: '587', encryption: 'tls' }
};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    // Proxy toggle
    document.querySelectorAll('input[name="useProxy"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            document.getElementById('proxyConfig').style.display = 
                e.target.value === 'yes' ? 'block' : 'none';
        });
    });

    updateHostConfig();
    addLog('🚀 SMTP Bulk Sender ready. Multi-SMTP support enabled.', 'info');
});

// ============================================
// SMTP Configuration Functions
// ============================================
function updateHostConfig() {
    const provider = document.getElementById('hostProvider').value;
    if (smtpPresets[provider]) {
        const config = smtpPresets[provider];
        document.getElementById('smtpHost').value = config.host;
        document.getElementById('smtpPort').value = config.port;
        const encRadio = document.querySelector(`input[name="encryption"][value="${config.encryption}"]`);
        if (encRadio) encRadio.checked = true;
    }
}

function getConfig() {
    return {
        host: document.getElementById('smtpHost').value,
        port: document.getElementById('smtpPort').value,
        encryption: document.querySelector('input[name="encryption"]:checked')?.value || 'tls',
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        fromName: document.getElementById('fromName').value,
        fromEmail: document.getElementById('fromEmail').value,
        subject: document.getElementById('subject').value,
        contentType: document.querySelector('input[name="contentType"]:checked')?.value || 'text',
        messageBody: document.getElementById('messageBody').value,
        useProxy: document.querySelector('input[name="useProxy"]:checked')?.value === 'yes',
        proxyList: document.getElementById('proxies').value.split('\n').filter(p => p.trim()),
        proxyRotation: document.querySelector('input[name="proxyRotation"]:checked')?.value || 'random'
    };
}

// ============================================
// Bulk SMTP Import Functions
// ============================================
function parseSMTPList() {
    const smtpText = document.getElementById('smtpList').value.trim();
    if (!smtpText) {
        alert('Please paste SMTP configurations first!');
        return;
    }

    smtpConfigs = [];
    const lines = smtpText.split('\n').filter(line => line.trim());

    for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 4) {
            smtpConfigs.push({
                host: parts[0].trim(),
                port: parts[1].trim(),
                username: parts[2].trim(),
                password: parts[3].trim(),
                status: 'pending'
            });
        }
    }

    if (smtpConfigs.length === 0) {
        alert('No valid SMTP configs found! Format: host|port|username|password');
        return;
    }

    displaySMTPTable();
    updateSMTPBadge();
    addLog(`✅ Parsed ${smtpConfigs.length} SMTP configurations`, 'success');
}

function displaySMTPTable() {
    const container = document.getElementById('smtpTableContainer');
    const tbody = document.getElementById('smtpTableBody');
    
    container.style.display = 'block';
    tbody.innerHTML = '';

    smtpConfigs.forEach((config, index) => {
        const row = document.createElement('tr');
        const statusClass = config.status === 'working' ? 'success' : 
                           config.status === 'failed' ? 'danger' : 'info';
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${config.host}</td>
            <td>${config.port}</td>
            <td>${config.username}</td>
            <td class="password-cell">${maskPassword(config.password)}</td>
            <td><span class="badge badge-${statusClass}">${config.status}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function updateSMTPBadge() {
    const working = smtpConfigs.filter(c => c.status === 'working').length;
    const failed = smtpConfigs.filter(c => c.status === 'failed').length;
    const badge = document.getElementById('smtpCount');
    
    if (smtpConfigs.length === 0) {
        badge.textContent = '0 SMTPs';
        badge.className = 'badge badge-info';
    } else if (failed > 0 && working === 0) {
        badge.textContent = `${smtpConfigs.length} SMTPs (${failed} failed)`;
        badge.className = 'badge badge-danger';
    } else if (working > 0) {
        badge.textContent = `${working} working, ${failed} failed`;
        badge.className = 'badge badge-success';
    } else {
        badge.textContent = `${smtpConfigs.length} SMTPs loaded`;
        badge.className = 'badge badge-info';
    }
}

function maskPassword(password) {
    if (!password) return '****';
    if (password.length <= 4) return '****';
    return password.substring(0, 2) + '****' + password.substring(password.length - 2);
}

function loadSMTPFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('smtpList').value = e.target.result;
        addLog(`📁 Loaded SMTP list from: ${file.name}`, 'info');
        parseSMTPList();
    };
    reader.readAsText(file);
}

async function testAllSMTP() {
    if (smtpConfigs.length === 0) {
        alert('Please parse SMTP list first!');
        return;
    }

    const testBtn = document.getElementById('testAllBtn');
    testBtn.disabled = true;
    testBtn.textContent = '⏳ Testing...';

    addLog(`🧪 Testing ${smtpConfigs.length} SMTP connections...`, 'info');

    for (let i = 0; i < smtpConfigs.length; i++) {
        const config = smtpConfigs[i];
        addLog(`Testing #${i + 1}: ${config.host} (${config.username})`, 'info');

        try {
            const response = await fetch('/api/test-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    smtpConfig: {
                        host: config.host,
                        port: config.port,
                        encryption: 'tls',
                        username: config.username,
                        password: config.password,
                        timeout: 10000
                    }
                })
            });

            const result = await response.json();
            
            if (result.success) {
                config.status = 'working';
                addLog(`✅ #${i + 1} WORKING: ${config.host}`, 'success');
            } else {
                config.status = 'failed';
                addLog(`❌ #${i + 1} FAILED: ${config.host} - ${result.message}`, 'error');
            }
        } catch (error) {
            config.status = 'failed';
            addLog(`❌ #${i + 1} ERROR: ${config.host} - ${error.message}`, 'error');
        }

        displaySMTPTable();
        updateSMTPBadge();
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const working = smtpConfigs.filter(c => c.status === 'working').length;
    const failed = smtpConfigs.filter(c => c.status === 'failed').length;
    addLog(`📊 Results: ${working} working, ${failed} failed out of ${smtpConfigs.length}`, 'info');
    
    testBtn.disabled = false;
    testBtn.textContent = '🧪 Test All SMTP';
}

function clearSMTPList() {
    document.getElementById('smtpList').value = '';
    smtpConfigs = [];
    document.getElementById('smtpTableContainer').style.display = 'none';
    updateSMTPBadge();
    addLog('🗑️ SMTP list cleared', 'info');
}

// ============================================
// Recipient Functions
// ============================================
function loadRecipientsFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const content = e.target.result;
        const emails = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        if (emails.length > 0) {
            const current = document.getElementById('recipients').value;
            document.getElementById('recipients').value = 
                current + (current ? '\n' : '') + emails.join('\n');
            addLog(`📋 Loaded ${emails.length} emails from ${file.name}`, 'info');
        }
    };
    reader.readAsText(file);
}

// ============================================
// Connection Testing
// ============================================
async function testConnection() {
    const config = getConfig();
    
    if (!config.host || !config.username || !config.password) {
        alert('Please fill in all SMTP configuration fields.');
        return;
    }

    addLog('🔍 Testing SMTP connection...', 'info');
    const testBtn = document.getElementById('testBtn');
    testBtn.disabled = true;
    testBtn.textContent = '⏳ Testing...';
    
    try {
        const response = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                smtpConfig: {
                    host: config.host,
                    port: config.port,
                    encryption: config.encryption,
                    username: config.username,
                    password: config.password,
                    timeout: 30000
                }
            })
        });

        const result = await response.json();
        
        if (result.success) {
            addLog('✅ Connection test SUCCESSFUL!', 'success');
            alert(`✅ Connection successful!\nServer: ${config.host}:${config.port}`);
        } else {
            addLog('❌ Connection test FAILED: ' + result.message, 'error');
            alert('❌ Connection failed: ' + result.message);
        }
    } catch (error) {
        addLog('❌ Connection error: ' + error.message, 'error');
        alert('Connection error: ' + error.message);
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = '🔍 Test Connection';
    }
}

// ============================================
// Bulk Sending Functions
// ============================================
async function startSending() {
    const config = getConfig();
    const useMultiSMTP = smtpConfigs.length > 0;
    
    if (!useMultiSMTP && (!config.host || !config.username || !config.password)) {
        alert('Please configure SMTP or import SMTP list.');
        return;
    }

    const recipients = document.getElementById('recipients').value
        .split('\n').map(e => e.trim()).filter(e => e && e.includes('@'));

    if (recipients.length === 0) {
        alert('Please enter at least one recipient.');
        return;
    }

    if (!config.subject || !config.messageBody) {
        alert('Please enter subject and message body.');
        return;
    }

    const requestBody = {
        recipients,
        ccRecipients: document.getElementById('ccRecipients').value.split('\n').map(e => e.trim()).filter(e => e.includes('@')),
        bccRecipients: document.getElementById('bccRecipients').value.split('\n').map(e => e.trim()).filter(e => e.includes('@')),
        emailContent: {
            fromName: config.fromName,
            fromEmail: config.fromEmail,
            subject: config.subject,
            contentType: config.contentType,
            messageBody: config.messageBody,
            attachments: []
        },
        sendingOptions: {
            delay: parseInt(document.getElementById('delay').value),
            batchSize: parseInt(document.getElementById('batchSize').value),
            maxRetries: parseInt(document.getElementById('maxRetries').value),
            threads: parseInt(document.getElementById('threads').value),
            proxyRotation: config.proxyRotation
        },
        proxyList: config.useProxy ? config.proxyList : [],
        smtpRotation: document.querySelector('input[name="smtpRotation"]:checked')?.value || 'random'
    };

    if (useMultiSMTP) {
        requestBody.smtpConfigs = smtpConfigs;
        requestBody.smtpConfig = smtpConfigs[0];
    } else {
        requestBody.smtpConfig = {
            host: config.host,
            port: config.port,
            encryption: config.encryption,
            username: config.username,
            password: config.password,
            timeout: parseInt(document.getElementById('timeout').value) * 1000
        };
    }

    try {
        const response = await fetch('/api/send-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();
        
        if (result.success) {
            currentJobId = result.jobId;
            
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            document.getElementById('testBtn').disabled = true;
            document.getElementById('progressContainer').style.display = 'block';
            
            stats = {
                total: recipients.length,
                sent: 0,
                failed: 0,
                remaining: recipients.length
            };
            updateStats();
            
            addLog(`🚀 Bulk sending started. Job: ${result.jobId}`, 'info');
            if (useMultiSMTP) {
                addLog(`Using ${smtpConfigs.length} SMTP servers`, 'info');
            }
            
            startStatusPolling();
        } else {
            addLog('❌ Failed to start: ' + result.message, 'error');
            alert('Failed to start: ' + result.message);
        }
    } catch (error) {
        addLog('❌ Error: ' + error.message, 'error');
        alert('Error: ' + error.message);
    }
}

function startStatusPolling() {
    if (statusPollingInterval) clearInterval(statusPollingInterval);
    
    statusPollingInterval = setInterval(async () => {
        if (!currentJobId) {
            clearInterval(statusPollingInterval);
            return;
        }
        
        try {
            const response = await fetch(`/api/job-status/${currentJobId}`);
            const result = await response.json();
            
            if (result.success) {
                const job = result.job;
                
                stats = {
                    total: job.stats.total,
                    sent: job.stats.sent,
                    failed: job.stats.failed,
                    remaining: job.stats.remaining
                };
                updateStats();
                
                const logContainer = document.getElementById('logContainer');
                job.logs.forEach(log => {
                    const logKey = `${log.timestamp}-${log.message}`;
                    if (!document.querySelector(`[data-log="${logKey}"]`)) {
                        const logEntry = document.createElement('div');
                        logEntry.className = `log-entry log-${log.type}`;
                        logEntry.setAttribute('data-log', logKey);
                        const time = new Date(log.timestamp).toLocaleTimeString();
                        logEntry.textContent = `[${time}] ${log.message}`;
                        logContainer.appendChild(logEntry);
                    }
                });
                logContainer.scrollTop = logContainer.scrollHeight;
                
                if (job.status === 'completed' || job.status === 'stopped' || job.status === 'error') {
                    clearInterval(statusPollingInterval);
                    statusPollingInterval = null;
                    
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = true;
                    document.getElementById('testBtn').disabled = false;
                    
                    addLog(`📊 Job ${job.status}. Sent: ${job.stats.sent}, Failed: ${job.stats.failed}`, 'info');
                }
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 2000);
}

async function stopSending() {
    if (!currentJobId) return;
    
    try {
        const response = await fetch(`/api/stop-job/${currentJobId}`, { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            shouldStop = true;
            addLog('⏹️ Stopping...', 'info');
        }
    } catch (error) {
        addLog('Error stopping: ' + error.message, 'error');
    }
}

// ============================================
// Utility Functions
// ============================================
function addLog(message, type = 'info') {
    const logContainer = document.getElementById('logContainer');
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry log-${type}`;
    const timestamp = new Date().toLocaleTimeString();
    logEntry.textContent = `[${timestamp}] ${message}`;
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
    logs.push({ timestamp, message, type });
}

function updateStats() {
    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statSent').textContent = stats.sent;
    document.getElementById('statFailed').textContent = stats.failed;
    document.getElementById('statRemaining').textContent = stats.remaining;
    
    const progressPercent = stats.total > 0 ? Math.round((stats.sent / stats.total) * 100) : 0;
    const progressFill = document.getElementById('progressFill');
    progressFill.style.width = progressPercent + '%';
    progressFill.textContent = progressPercent + '%';
}

function exportLogs() {
    if (logs.length === 0) {
        alert('No logs to export!');
        return;
    }
    
    const logText = logs.map(log => 
        `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`
    ).join('\n');
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smtp-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('📊 Logs exported!', 'info');
}