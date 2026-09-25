/* =============================================================
   First-run setup, executed automatically before `npm start`:
   - checks the Node.js version (the built-in SQLite needs 22.13+)
   - creates .env with a random admin password if it does not exist
   ============================================================= */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`\n  ✗ Node.js ${process.versions.node} قديم. هذا النظام يحتاج الإصدار 22.13 أو أحدث.`);
    console.error('    نزّل النسخة LTS من https://nodejs.org ثم أعد المحاولة.\n');
    process.exit(1);
}

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');

if (!fs.existsSync(envFile)) {
    const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const token = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(envFile, template.replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${token}`));
    console.log('\n  ✓ تم إنشاء ملف الإعدادات .env');
}

const match = fs.readFileSync(envFile, 'utf8').match(/^ADMIN_TOKEN=(.*)$/m);
const token = match ? match[1].trim() : '';
console.log('\n  ════════════════════════════════════════════');
if (!token || token === 'change-me-to-a-long-random-string') {
    console.log('  ! ضع كلمة سر للوحة الإدارة في ملف .env (السطر ADMIN_TOKEN=)');
} else {
    console.log(`  كلمة سر لوحة الإدارة:  ${token}`);
}
console.log('  (يمكنك تغييرها من ملف .env)');
console.log('  ════════════════════════════════════════════\n');
