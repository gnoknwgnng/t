const fs = require('fs');
const path = require('path');

const requiredPaths = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', 'public', 'generator.html'),
    path.join(__dirname, '..', 'public', 'publisher.html'),
    path.join(__dirname, '..', 'public', 'auth.html'),
    path.join(__dirname, '..', 'services', 'oauthService.js'),
    path.join(__dirname, '..', 'services', 'publishingStore.js')
];

const missingPaths = requiredPaths.filter((filePath) => !fs.existsSync(filePath));

if (missingPaths.length) {
    console.error('Build validation failed. Missing required files:');
    missingPaths.forEach((filePath) => console.error(`- ${filePath}`));
    process.exit(1);
}

console.log('Build validation passed. All required local server files are present.');
