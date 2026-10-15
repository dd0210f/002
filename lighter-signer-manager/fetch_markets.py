import asyncio
import os
import sys

# Add current directory to path to find lighter module if it's local, 
# but usually it's installed in venv.
sys.path.append(os.getcwd())

try:
    from lighter import ApiClient, Configuration, OrderApi
except ImportError:
    print("Error: 'lighter' module not found. Please run this script in the correct virtual environment.")
    sys.exit(1)

async def main():
    # Use mainnet URL
    url = "https://mainnet.zklighter.elliot.ai"
    conf = Configuration(host=url)
    api_client = ApiClient(configuration=conf)
    order_api = OrderApi(api_client)
    
    try:
        print(f"Fetching order books from {url}...")
        books = await order_api.order_books()
        
        print("\nAvailable Markets:")
        print("-" * 60)
        print(f"{'Index':<10} {'Symbol':<20} {'Market ID':<30}")
        print("-" * 60)
        
        # Sort by market_id just in case
        sorted_markets = sorted(books.order_books, key=lambda x: x.market_id)
        
        for market in sorted_markets:
            print(f"{market.market_id:<10} {market.symbol:<20} {market.market_id:<30}")
            
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await api_client.close()

if __name__ == "__main__":
    asyncio.run(main())
