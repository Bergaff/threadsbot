export type InlineButton = { text: string; callback_data?: string; url?: string };
export type Keyboard = { inline_keyboard: InlineButton[][] };

export interface TgUser { id: number; is_bot?: boolean; username?: string; language_code?: string; }
export interface TgMessage {
  message_id: number; chat: { id: number }; from?: TgUser; text?: string; caption?: string;
  reply_to_message?: TgMessage;
  successful_payment?: { total_amount: number; invoice_payload: string };
}
export interface CallbackQuery { id: string; from: TgUser; data?: string; message?: TgMessage; }
export interface TelegramUpdate { update_id: number; message?: TgMessage; callback_query?: CallbackQuery; pre_checkout_query?: { id: string; from: TgUser }; }

type ApiResult<T> = { ok: boolean; result: T; description?: string };

export class Telegram {
  constructor(private readonly token: string) {}
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json<ApiResult<T>>();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || response.status}`);
    return data.result;
  }
  getMe(): Promise<TgUser> { return this.call("getMe", {}); }
  sendMessage(chat_id: number, text: string, reply_markup?: Keyboard): Promise<TgMessage> {
    return this.call("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup });
  }
  editText(chat_id: number, message_id: number, text: string, reply_markup?: Keyboard): Promise<unknown> {
    return this.call("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", reply_markup });
  }
  editMarkup(chat_id: number, message_id: number, reply_markup?: Keyboard): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
  }
  deleteMessage(chat_id: number, message_id: number): Promise<unknown> {
    return this.call("deleteMessage", { chat_id, message_id });
  }
  answerCallbackQuery(callback_query_id: string, value: { text?: string; show_alert?: boolean } = {}): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id, ...value });
  }
  answerPreCheckoutQuery(id: string, ok = true): Promise<unknown> {
    return this.call("answerPreCheckoutQuery", { pre_checkout_query_id: id, ok });
  }
  sendInvoice(chat_id: number, title: string, description: string, payload: string, amount: number): Promise<unknown> {
    return this.call("sendInvoice", { chat_id, title, description, payload, currency: "XTR", prices: [{ label: title, amount }] });
  }
  async sendPhoto(chatId: number, bytes: Uint8Array, caption: string): Promise<unknown> {
    const form = new FormData();
    form.set("chat_id", String(chatId)); form.set("caption", caption);
    form.set("photo", new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/png" }), "post.png");
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: "POST", body: form });
    const data = await response.json<ApiResult<unknown>>();
    if (!data.ok) throw new Error(`Telegram sendPhoto: ${data.description || response.status}`);
    return data.result;
  }
}

export const kb = (inline_keyboard: InlineButton[][]): Keyboard => ({ inline_keyboard });
