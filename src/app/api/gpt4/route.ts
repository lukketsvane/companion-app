import { OpenAI } from "langchain/llms/openai";
import dotenv from "dotenv";
import { LLMChain } from "langchain/chains";
import { StreamingTextResponse, LangChainStream } from "ai";
import clerk from "@clerk/clerk-sdk-node";
import { CallbackManager } from "langchain/callbacks";
import { PromptTemplate } from "langchain/prompts";
import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs";
import MemoryManager from "@/app/utils/memory";
import { rateLimit } from "@/app/utils/rateLimit";

dotenv.config({ path: `.env.local` });

export async function POST(req: Request) {
  let clerkUserId;
  let user;
  let clerkUserName;
  const { prompt, isText, userId, userName } = await req.json();

  const identifier = req.url + "-" + (userId || "anonymous");
  const { success } = await rateLimit(identifier);
  if (!success) {
    console.log("INFO: Begrensning i antall forespørsler er overskredet");
    return new NextResponse(
      JSON.stringify({ Message: "Hei, kameratene kan ikke snakke så fort." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  // XXX Companion name passed here. Can use as a key to get backstory, chat history etc.
  const name = req.headers.get("name");
  const companionFileName = name + ".txt";

  console.log("prompt: ", prompt);
  if (isText) {
    clerkUserId = userId;
    clerkUserName = userName;
  } else {
    user = await currentUser();
    clerkUserId = user?.id;
    clerkUserName = user?.firstName;
  }

  if (!clerkUserId || !!!(await clerk.users.getUser(clerkUserId))) {
    console.log("user not authorized");
    return new NextResponse(
      JSON.stringify({ Message: "User not authorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  // Load character "PREAMBLE" from character file. These are the core personality
  // characteristics that are used in every prompt. Additional background is
  // only included if it matches a similarity comparioson with the current
  // discussion. The PREAMBLE should include a seed conversation whose format will
  // vary by the model using it.
  const fs = require("fs").promises;
  const data = await fs.readFile("companions/" + companionFileName, "utf8");

  // Clunky way to break out PREAMBLE and SEEDCHAT from the character file
  const presplit = data.split("###ENDPREAMBLE###");
  const preamble = presplit[0];
  const seedsplit = presplit[1].split("###ENDSEEDCHAT###");
  const seedchat = seedsplit[0];

  const companionKey = {
    companionName: name!,
    modelName: "gpt-4",
    userId: clerkUserId,
  };
  const memoryManager = await MemoryManager.getInstance();

  const records = await memoryManager.readLatestHistory(companionKey);
  if (records.length === 0) {
    await memoryManager.seedChatHistory(seedchat, "\n\n", companionKey);
  }

  await memoryManager.writeToHistory("Menneske: " + prompt + "\n", companionKey);
  let recentChatHistory = await memoryManager.readLatestHistory(companionKey);

  // query Pinecone
  const similarDocs = await memoryManager.vectorSearch(
    recentChatHistory,
    companionFileName
  );

  let relevantHistory = "";
  if (!!similarDocs && similarDocs.length !== 0) {
    relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
  }

  const { stream, handlers } = LangChainStream();

  const model = new OpenAI({
    streaming: true,
    modelName: "gpt-4",
    openAIApiKey: process.env.OPENAI_API_KEY,
    callbackManager: CallbackManager.fromHandlers(handlers),
  });
  model.verbose = true;

  const replyWithTwilioLimit = isText
    ? "Du svarer ikke lenger enn 1000 tegn."
    : "";

    const chainPrompt = PromptTemplate.fromTemplate(`
    Du er ${name} og snakker for øyeblikket med ${clerkUserName}.

    ${preamble}

    Svarene du gir varierer i lengde fra en setning til ett avsnitt, og inkluderer inkluderer visse detaljer.  ${replyWithTwilioLimit}

    Detaljene som er relevante for ${name}'s bakgrunn, er som følger
  ${relevantHistory}
  
  Nedenfor er en relevant samtalehistorikk

  ${recentChatHistory}`);

  const chain = new LLMChain({
    llm: model,
    prompt: chainPrompt,
  });

  const result = await chain
    .call({
      relevantHistory,
      recentChatHistory: recentChatHistory,
    })
    .catch(console.error);

  console.log("result", result);
  const chatHistoryRecord = await memoryManager.writeToHistory(
    result!.text + "\n",
    companionKey
  );
  console.log("chatHistoryRecord", chatHistoryRecord);
  if (isText) {
    return NextResponse.json(result!.text);
  }
  return new StreamingTextResponse(stream);
}
