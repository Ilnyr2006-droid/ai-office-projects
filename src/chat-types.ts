export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type LeadRecord = {
  id?: string;
  createdAt?: string;
  name?: string;
  phone?: string;
  contact?: string;
  interest?: string;
  notes?: string;
  transcript?: string;
  source?: string;
};

export type CatalogProductMedia = {
  type?: string;
  url?: string;
};

export type CatalogProductAttributes = {
  colors?: string[];
  thicknessMm?: string;
};

export type CatalogProduct = {
  id?: string;
  name?: string;
  category?: string;
  categories?: string[];
  description?: string;
  shortDescription?: string;
  thickness?: string;
  materialType?: string;
  leatherType?: string;
  origin?: string;
  minimumOrder?: string;
  stock?: string;
  unit?: string;
  priceFrom?: string;
  priceFromValue?: number;
  photo?: string;
  photos?: string[];
  colors?: string[];
  applications?: string[];
  attributes?: CatalogProductAttributes;
  media?: CatalogProductMedia[];
  pricing?: {
    from?: number;
    fromText?: string;
    currency?: string;
    unit?: string;
    approximate?: boolean;
  };
  variants?: Array<{
    title?: string;
    price?: string | number;
    priceValue?: number;
    currency?: string;
    unit?: string;
    options?: Record<string, string>;
  }>;
};

export type ProductAttachment = {
  type: "image";
  url: string;
  name: string;
  category?: string;
  price?: string;
  colors?: string[];
  applications?: string[];
  thickness?: string;
  materialType?: string;
  leatherType?: string;
  stock?: string;
};

export type SellerReplyGenerationResult = {
  reply: string;
  topProducts: CatalogProduct[];
  relevantProducts: CatalogProduct[];
};

export type GenerateSellerReplyOptions = {
  canSendProductPhotos?: boolean;
};

export type AnswerManagerQuestionInput = {
  question?: string;
  lead?: LeadRecord | null;
  transcript?: string;
  recentMessages?: ChatMessage[];
};

export type ProcessChatMessagesInput = {
  chatId?: string;
  messages: unknown[];
};

export type ProcessChatMessagesResult = {
  reply: string;
  attachments: ProductAttachment[];
  chatId: string | null;
  messages: ChatMessage[];
};

export type CandidateFilters = {
  colors: string[];
};

export type AttachmentProductsParams = {
  message: string;
  messages: ChatMessage[];
  generationResult: SellerReplyGenerationResult;
};

export type PreviousPhotoLookupParams = {
  message: string;
  messages: ChatMessage[];
  recentConversationProducts: CatalogProduct[];
};

export type OrderSession = {
  interest: string;
  quantity: string;
  name: string;
  contact: string;
  productName?: string;
  unitPriceValue?: number | null;
  unitPriceLabel?: string;
  totalPriceValue?: number | null;
  totalPriceLabel?: string;
  suggestedAddons?: string[];
  awaitingConfirmation?: boolean;
  updatedAt?: string;
};

export type ChatFollowUpCandidate = {
  chatId: string;
  updatedAt?: string;
  lastCustomerMessageAt?: string;
  lastFollowUpAt?: string;
};

export type TelegramUser = {
  id?: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramLeadOptions = {
  clientChatId?: string | number;
  targetChatId?: string | number;
  forbiddenChatIds?: Array<string | number>;
  telegramUser?: TelegramUser;
};

export type TelegramChat = {
  id?: string | number;
  type?: string;
};

export type TelegramMessage = {
  message_id?: number;
  text?: string;
  from?: TelegramUser;
  chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

export type TelegramApiMessageResult = {
  message_id?: number;
  chat?: {
    id?: string | number;
  };
};

export type TelegramApiResponse<T = unknown> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

export type TelegramLeadThread = {
  leadId: string;
  clientChatId: string;
  groupChatId: string;
  rootGroupMessageId: string;
  groupMessageIds: string[];
  pendingManagerQuestion: string;
  leadSnapshot: LeadRecord;
  clientSnapshot: {
    username: string;
    fullName: string;
    clientChatId: string;
  };
  createdAt: string;
  updatedAt?: string;
};
