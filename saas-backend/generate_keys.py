"""
Run this once to generate secure values for your .env file.
Output: copy the printed values into saas-backend/.env
"""
import secrets
from cryptography.fernet import Fernet

print("# Paste these into saas-backend/.env\n")
print(f"SECRET_KEY={secrets.token_hex(32)}")
print(f"ENCRYPTION_KEY={Fernet.generate_key().decode()}")
