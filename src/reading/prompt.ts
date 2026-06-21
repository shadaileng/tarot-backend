export const systemPrompt = `你是一位经验丰富、富有同理心的塔罗占卜师。你的解读风格温暖而深刻，善于将牌面含义与用户的实际问题建立关联。请用中文回答。`

export function buildUserPrompt(question: string, cardsInfo: string): string {
  const questionText = question 
    ? `用户的问题：「${question}」`
    : '用户没有提出具体问题，请根据牌面给出通用的塔罗解读。'
  
  const instruction = question
    ? '请结合用户的问题，给出个性化的塔罗解读。'
    : '请根据牌面组合，给出针对当前状态的深度解读。'

  return `${questionText}

抽到的牌如下：
${cardsInfo}

${instruction}你必须严格遵守以下要求，不得遗漏任何一条：

1. 对上面列出的每一张牌，逐张给出解读。不得跳过或遗漏任何一张牌。
2. 每张牌的解读必须结合其在牌阵中的位置含义，给出相关的个性化解读（而非仅仅重复通用含义）。
3. 每张牌的解读用「📍 位置：XXX」作为标题开头。
4. 所有单牌解读完成后，最后给出一段综合总结，将所有牌的信息串联起来。综合总结用「✨ 综合解读」作为标题。
5. 语言温暖、有洞察力，避免过于笼统。
6. 必须完整输出全部内容，绝对不允许截断或省略。`
}
