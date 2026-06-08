import the50000Join from './posts/the-50000-join.md?raw';
import aiSqlMistakes from './posts/ai-sql-mistakes.md?raw';

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  publishedAt: string; // ISO date
  readingMinutes: number;
  tags: string[];
  content: string; // raw markdown
}

export const posts: BlogPost[] = [
  {
    slug: 'the-50000-join',
    title: 'The $50,000 JOIN: How a syntactically valid query broke our revenue for 6 months',
    description:
      'A post-mortem walkthrough of the most common and costly SQL error in analytics engineering — JOIN multiplication.',
    publishedAt: '2026-06-08',
    readingMinutes: 8,
    tags: ['sql', 'data-engineering', 'joins', 'analytics'],
    content: the50000Join,
  },
  {
    slug: 'ai-sql-mistakes',
    title: "AI writes SQL 4× faster. It's also wrong 25% of the time.",
    description:
      "The BIRD benchmark shows LLMs achieve 75% execution accuracy on SQL. Here's what the 25% looks like — and how to catch it.",
    publishedAt: '2026-06-08',
    readingMinutes: 6,
    tags: ['ai', 'llm', 'sql', 'cursor', 'copilot'],
    content: aiSqlMistakes,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}
