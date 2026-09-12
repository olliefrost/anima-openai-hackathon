import { adk } from '@animahealth/adk';
import { openai } from '@animahealth/adk/openai';

process.loadEnvFile();

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set. Export it before running the agent.');
}

const app = adk();

const assistant = app.agent({
  name: 'assistant',
  model: openai('gpt-5.6-luna'),
  context: [
    app.context.system('You are a helpful assistant. Answer concisely.'),
    app.context.history(),
  ],
});

const prompt = process.argv.slice(2).join(' ') || 'Suggest a name for a booking assistant.';
const run = await app.run(assistant, prompt);

console.log(run.output.text);
