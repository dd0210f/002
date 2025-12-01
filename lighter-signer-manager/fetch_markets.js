const https = require('https');

const urls = [
    "https://mainnet.zklighter.elliot.ai/api/v1/order-books",
    "https://mainnet.zklighter.elliot.ai/api/v1/order-book",
    "https://mainnet.zklighter.elliot.ai/order-books",
    "https://api.lighter.xyz/api/v1/order-books"
];

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        console.log(`Fetching ${url}...`);
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`Status ${res.statusCode}`));
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    for (const url of urls) {
        try {
            const data = await fetchUrl(url);
            console.log(`\nSuccess with ${url}!`);

            const json = JSON.parse(data);
            const markets = json.order_books || json.result || json.data;

            if (!markets) {
                console.log("Unknown response structure:", Object.keys(json));
                continue;
            }

            console.log("\nAvailable Markets:");
            console.log("-".repeat(60));
            console.log(
                "Index".padEnd(10) +
                "Symbol".padEnd(20) +
                "Market ID".padEnd(30)
            );
            console.log("-".repeat(60));

            // Handle different structures if needed
            const list = Array.isArray(markets) ? markets : [];

            list.sort((a, b) => a.market_id - b.market_id);

            list.forEach(m => {
                console.log(
                    String(m.market_id).padEnd(10) +
                    String(m.symbol).padEnd(20) +
                    String(m.market_id).padEnd(30)
                );
            });

            return; // Stop after success
        } catch (e) {
            console.log(`Failed: ${e.message}`);
        }
    }
    console.log("All URLs failed.");
}

main();
