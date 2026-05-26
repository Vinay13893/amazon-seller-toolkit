"""
Example: Request a permission from Telegram.

Run the bot first (python bot.py), then run this in another terminal.
Or use the combined approach below.
"""

import asyncio
from bot import request_permission, run_bot


async def main():
    # Start the bot in the background
    bot_task = asyncio.create_task(run_bot())

    # Wait a moment for the bot to initialize
    await asyncio.sleep(2)

    # Send a permission request
    print("Sending permission request to Telegram...")
    approved = await request_permission(
        "VS Code wants to execute a script.\n"
        "Action: Run deployment pipeline\n"
        "Details: Deploy to production server"
    )

    if approved:
        print("Permission GRANTED - proceeding...")
        # Do the protected action here
    else:
        print("Permission DENIED - aborting.")

    # Cancel the bot
    bot_task.cancel()
    try:
        await bot_task
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    asyncio.run(main())
