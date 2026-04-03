function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function getDefaultGroqModel() {
  return String(process.env.GROQ_MODEL ?? "llama-3.1-8b-instant").trim() || "llama-3.1-8b-instant";
}

function getClient() {
  const apiKey = requiredEnv("GROQ_API_KEY");
  return { apiKey };
}

async function groqChat({ apiKey, messages, model = getDefaultGroqModel(), temperature = 0.2 }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const payload = {
    model,
    messages,
    temperature,
  };

  if (typeof fetch === "function") {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Groq API error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  }

  const { request } = await import("node:https");

  const text = await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );

    req.on("error", reject);
    req.write(JSON.stringify(payload));
    req.end();
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Groq API error: ${text.slice(0, 500)}`);
  }

  if (!data || data.error) {
    throw new Error(`Groq API error: ${JSON.stringify(data?.error ?? data).slice(0, 500)}`);
  }

  return data?.choices?.[0]?.message?.content ?? "";
}

export async function geminiJson({ system, user, schemaHint }) {
  const prompt = [
    system ? `SYSTEM:\n${system}` : null,
    schemaHint ? `OUTPUT JSON SCHEMA HINT:\n${schemaHint}` : null,
    `USER:\n${user}`,
    "Return ONLY valid JSON. No markdown.",
  ].filter(Boolean).join("\n\n");

  const client = getClient();
  const text = await groqChat({
    apiKey: client.apiKey,
    messages: [
      system ? { role: "system", content: system } : null,
      { role: "user", content: prompt },
    ].filter(Boolean),
  });

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Groq returned non-JSON: ${text.slice(0, 500)}`);
  }
}

export async function geminiText({ system, user }) {
  const client = getClient();
  const prompt = [system ? `SYSTEM:\n${system}` : null, `USER:\n${user}`].filter(Boolean).join("\n\n");
  return await groqChat({
    apiKey: client.apiKey,
    messages: [
      system ? { role: "system", content: system } : null,
      { role: "user", content: prompt },
    ].filter(Boolean),
    temperature: 0.7,
  });
}
