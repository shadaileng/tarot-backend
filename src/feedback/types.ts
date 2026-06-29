export interface FeedbackCreateRequest {
  category: string
  content: string
  images?: string[]
}

export interface FeedbackReplyRequest {
  reply: string
}

export interface FeedbackStatusUpdate {
  status: 'pending' | 'replied' | 'closed'
}
