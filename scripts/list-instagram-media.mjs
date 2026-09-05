import fs from "fs";

function loadEnv() {
  const text = fs.readFileSync(".env.local", "utf8");

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const accessToken =
  process.env.INSTAGRAM_ACCESS_TOKEN;

const accountId =
  process.env.INSTAGRAM_ACCOUNT_ID;

const version =
  process.env.INSTAGRAM_GRAPH_VERSION || "v26.0";

if (!accessToken) {
  throw new Error(
    "INSTAGRAM_ACCESS_TOKEN is missing"
  );
}

if (!accountId) {
  throw new Error(
    "INSTAGRAM_ACCOUNT_ID is missing"
  );
}

const params =
  new URLSearchParams({
    fields:
      "id,caption,media_type,permalink,timestamp",
    limit: "25",
  });

const response =
  await fetch(
    `https://graph.instagram.com/${version}/${accountId}/media?${params}`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
      },
    }
  );

const data =
  await response.json();

if (!response.ok) {
  console.error(data);
  process.exit(1);
}

for (const media of data.data ?? []) {
  console.log("\n------------------------------");
  console.log("ID:", media.id);
  console.log("TYPE:", media.media_type);
  console.log("DATE:", media.timestamp);
  console.log("URL:", media.permalink);
  console.log(
    "CAPTION:",
    media.caption?.slice(0, 100) ?? ""
  );
}