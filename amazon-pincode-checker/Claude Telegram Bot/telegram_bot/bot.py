"""
Telegram Permission Bot
Sends permission requests to your Telegram and lets you approve/reject.
"""

import asyncio
import os
import uuid
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = int(os.getenv("TELEGRAM_CHAT_ID"))

# Store pending permission requests: {request_id: asyncio.Future}
_pending_requests: dict[str, asyncio.Future] = {}

# Global application reference
_app: Application | None = None


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command."""
    await update.message.reply_text(
        "Permission Bot is active.\n"
        "I'll send you permission requests from VS Code.\n"
        "You can approve or reject them with the buttons."
    )


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle approve/reject button presses."""
    query = update.callback_query
    await query.answer()

    action, request_id = query.data.split(":", 1)
    approved = action == "approve"

    # Update the message to show the decision
    status = "APPROVED" if approved else "REJECTED"
    await query.edit_message_text(
        text=f"{query.message.text}\n\n--- {status} ---"
    )

    # Resolve the pending future
    future = _pending_requests.pop(request_id, None)
    if future and not future.done():
        future.set_result(approved)


async def request_permission(description: str, timeout: float = 300) -> bool:
    """
    Send a permission request to Telegram and wait for approval.

    Args:
        description: What you're requesting permission for.
        timeout: Seconds to wait before auto-rejecting (default 5 min).

    Returns:
        True if approved, False if rejected or timed out.
    """
    request_id = uuid.uuid4().hex[:8]
    future = asyncio.get_event_loop().create_future()
    _pending_requests[request_id] = future

    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Approve", callback_data=f"approve:{request_id}"),
            InlineKeyboardButton("Reject", callback_data=f"reject:{request_id}"),
        ]
    ])

    await _app.bot.send_message(
        chat_id=CHAT_ID,
        text=f"Permission Request\n\n{description}",
        reply_markup=keyboard,
    )

    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        _pending_requests.pop(request_id, None)
        await _app.bot.send_message(
            chat_id=CHAT_ID,
            text=f"Permission request timed out (auto-rejected):\n{description}",
        )
        result = False

    return result


async def run_bot():
    """Start the bot (polling mode)."""
    global _app
    _app = Application.builder().token(BOT_TOKEN).build()
    _app.add_handler(CommandHandler("start", start_command))
    _app.add_handler(CallbackQueryHandler(handle_callback))

    print("Bot is running... Press Ctrl+C to stop.")
    await _app.initialize()
    await _app.start()
    await _app.updater.start_polling()

    # Keep running until cancelled
    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    finally:
        await _app.updater.stop()
        await _app.stop()
        await _app.shutdown()


def start_bot_background() -> asyncio.Task:
    """Start the bot as a background asyncio task."""
    return asyncio.create_task(run_bot())


if __name__ == "__main__":
    asyncio.run(run_bot())
