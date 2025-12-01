from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    lighter_base_url: str
    lighter_network: str = "mainnet"
    api_key_private_key: str
    lighter_account_index: int = 0
    lighter_api_key_index: int = 0
    lighter_max_orders_limit: int = 100

    signer_host: str = "127.0.0.1"
    signer_port: int = 8787

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
