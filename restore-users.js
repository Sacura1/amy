// Restore users to Railway production database
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const API_URL = 'https://amy-production-fd10.up.railway.app/api/users/restore';
const ADMIN_WALLET = '0x296E35950Dacb58692D0693834F28C4692B36DC3'; // Your admin wallet

// Read local verified-users.json
const usersData = JSON.parse(fs.readFileSync(path.join(__dirname, 'backend', 'verified-users.json'), 'utf8'));

console.log('📋 Restoring', usersData.users.length, 'users to Railway...');

const data = JSON.stringify({
    users: usersData.users
});

const url = new URL(API_URL + '?wallet=' + ADMIN_WALLET);

const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = https.request(options, (res) => {
    let responseData = '';

    res.on('data', (chunk) => {
        responseData += chunk;
    });

    res.on('end', () => {
        console.log('\n📡 Response Status:', res.statusCode);
        console.log('📄 Response:', responseData);

        if (res.statusCode === 200) {
            const result = JSON.parse(responseData);
            console.log('\n✅ SUCCESS!');
            console.log('   Added:', result.added);
            console.log('   Updated:', result.updated);
            console.log('   Total users:', result.total);
        } else {
            console.error('\n❌ FAILED!');
            console.error('   Status:', res.statusCode);
            console.error('   Error:', responseData);
        }
    });
});

req.on('error', (error) => {
    console.error('❌ Request failed:', error);
});

req.write(data);
req.end();
