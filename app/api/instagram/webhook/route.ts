import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import OpenAI from "openai";

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const FIRST_DM =
  "Hey bro! I saw that you're interested in the calisthenics community. Do you want me to add you to the waitlist for when it releases?";

type WaitlistDecision = {
  reply: string;
  action:
    | "reply"
    | "ask_username"
    | "ask_email"
    | "decline";
};

// ======================================================
// GET
// META WEBHOOK VERIFICATION
// ======================================================

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const mode =
    searchParams.get("hub.mode");

  const token =
    searchParams.get(
      "hub.verify_token"
    );

  const challenge =
    searchParams.get(
      "hub.challenge"
    );

  if (
    mode === "subscribe" &&
    token ===
      process.env
        .INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  ) {
    console.log(
      "Instagram webhook verified"
    );

    return new NextResponse(
      challenge ?? "",
      {
        status: 200,
      }
    );
  }

  console.error(
    "Instagram webhook verification failed"
  );

  return new NextResponse(
    "Forbidden",
    {
      status: 403,
    }
  );
}

// ======================================================
// POST
// COMMENT + MESSAGE WEBHOOKS
// ======================================================

export async function POST(
  req: NextRequest
) {
  try {
    const rawBody =
      await req.text();

    if (
      !verifyInstagramSignature(
        req,
        rawBody
      )
    ) {
      console.error(
        "Invalid Instagram webhook signature"
      );

      return NextResponse.json(
        {
          error:
            "Invalid signature",
        },
        {
          status: 401,
        }
      );
    }

    const body =
      JSON.parse(rawBody);

    console.log(
      "INSTAGRAM EVENT:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    if (
      body.object !==
      "instagram"
    ) {
      return NextResponse.json({
        received: true,
      });
    }

    for (
      const entry of
      body.entry ?? []
    ) {
      console.log(
        "ENTRY DEBUG:",
        JSON.stringify(
          entry,
          null,
          2
        )
      );

      let commentHandled =
        false;

      // ==================================================
      // COMMENT FORMAT 1
      // entry.field + entry.value
      // ==================================================

      if (
        entry.field ===
          "comments" &&
        entry.value
      ) {
        console.log(
          "COMMENT WEBHOOK DETECTED: direct format"
        );

        await handleComment(
          entry.value
        );

        commentHandled =
          true;
      }

      // ==================================================
      // COMMENT FORMAT 2
      // entry.changes[]
      // ==================================================

      if (!commentHandled) {
        for (
          const change of
          entry.changes ?? []
        ) {
          console.log(
            "CHANGE FIELD:",
            change?.field
          );

          console.log(
            "CHANGE VALUE:",
            JSON.stringify(
              change?.value,
              null,
              2
            )
          );

          if (
            change?.field ===
              "comments" &&
            change?.value
          ) {
            console.log(
              "COMMENT WEBHOOK DETECTED: changes format"
            );

            await handleComment(
              change.value
            );

            commentHandled =
              true;

            break;
          }
        }
      }

      // ==================================================
      // INSTAGRAM DMS
      // ==================================================

      for (
        const event of
        entry.messaging ?? []
      ) {
        await handleMessage(
          event
        );
      }
    }

    return NextResponse.json({
      received: true,
    });
  } catch (error) {
    console.error(
      "Instagram webhook error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Webhook failed",
      },
      {
        status: 500,
      }
    );
  }
}

// ======================================================
// HANDLE COMMENT
// ======================================================

async function handleComment(
  value: any
) {
  console.log(
    "HANDLE COMMENT CALLED:",
    JSON.stringify(
      value,
      null,
      2
    )
  );

  const commentId =
    value?.id;

  const username =
    value?.from?.username ??
    value?.username ??
    null;

  const text =
    value?.text ?? "";

  const mediaId =
    value?.media?.id ??
    value?.media_id ??
    null;

  if (
    !commentId ||
    !text
  ) {
    console.log(
      "Comment missing ID or text"
    );

    return;
  }

  console.log(
    "NEW COMMENT:",
    {
      commentId,
      username,
      text,
      mediaId,
    }
  );

  // ==================================================
  // DOES COMMENT MATCH COMMUNITY?
  // ==================================================

  if (
    !isCommunityTrigger(
      text
    )
  ) {
    console.log(
      "Comment does not match COMMUNITY"
    );

    return;
  }

  console.log(
    "COMMUNITY COMMENT DETECTED:",
    text
  );

  // ==================================================
  // CHECK EXACT COMMENT
  // ==================================================

  const {
    data:
      existingComment,
    error:
      existingCommentError,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .select(
      "id, status"
    )
    .eq(
      "source_comment_id",
      commentId
    )
    .maybeSingle();

  if (
    existingCommentError
  ) {
    console.error(
      "Comment lookup failed:",
      existingCommentError
    );

    return;
  }

  if (
    existingComment
  ) {
    console.log(
      "Comment already processed"
    );

    return;
  }

  // ==================================================
  // RESERVE COMMENT
  // ==================================================

  const {
    error:
      reserveError,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .insert({
      instagram_username:
        username,

      status:
        "pending",

      source_comment_id:
        commentId,

      source_media_id:
        mediaId,

      source_comment_text:
        text,
    });

  if (reserveError) {
    if (
      reserveError.code ===
      "23505"
    ) {
      console.log(
        "Duplicate comment ignored"
      );

      return;
    }

    console.error(
      "Failed to reserve comment:",
      reserveError
    );

    return;
  }

  try {
    console.log(
      "ATTEMPTING PRIVATE REPLY TO COMMENT:",
      commentId
    );

    const result =
      await sendPrivateReply(
        commentId,
        FIRST_DM
      );

    const recipientId =
      result?.recipient_id;

    if (!recipientId) {
      throw new Error(
        "Instagram did not return recipient_id"
      );
    }

    console.log(
      "PRIVATE REPLY SENT:",
      {
        username,
        recipientId,
      }
    );

    // ==================================================
    // CONNECT COMMENT LEAD TO DM USER ID
    // ==================================================

    const {
      error:
        updateError,
    } = await supabaseAdmin
      .from(
        "community_waitlist_leads"
      )
      .update({
        instagram_user_id:
          recipientId,

        status:
          "awaiting_confirmation",

        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "source_comment_id",
        commentId
      );

    if (updateError) {
      console.error(
        "Failed to update waitlist lead:",
        updateError
      );

      return;
    }

    await saveAssistantMessage(
      recipientId,
      FIRST_DM
    );
  } catch (error) {
    console.error(
      "Private reply failed:",
      error
    );

    // Remove reservation so it
    // can be retried later.
    await supabaseAdmin
      .from(
        "community_waitlist_leads"
      )
      .delete()
      .eq(
        "source_comment_id",
        commentId
      );

    throw error;
  }
}

// ======================================================
// HANDLE INSTAGRAM DM
// ======================================================

async function handleMessage(
  event: any
) {
  const senderId =
    event?.sender?.id;

  const message =
    event?.message;

  if (
    !senderId ||
    !message
  ) {
    return;
  }

  // Ignore our own messages.
  if (
    message.is_echo
  ) {
    return;
  }

  const text =
    message.text;

  const messageId =
    message.mid;

  if (
    !text ||
    !messageId
  ) {
    return;
  }

  console.log(
    "NEW INSTAGRAM DM:",
    {
      senderId,
      text,
      messageId,
    }
  );

  // ==================================================
  // FIND EXISTING WAITLIST LEAD
  // ==================================================

  const {
    data: lead,
    error:
      leadError,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .select("*")
    .eq(
      "instagram_user_id",
      senderId
    )
    .maybeSingle();

  if (leadError) {
    console.error(
      "Waitlist lead lookup failed:",
      leadError
    );

    return;
  }

  // ==================================================
  // DIRECT DM "COMMUNITY"
  //
  // Person can enter without commenting.
  // ==================================================

  if (!lead) {
    if (
      !isCommunityTrigger(
        text
      )
    ) {
      console.log(
        "Normal DM unrelated to waitlist"
      );

      return;
    }

    console.log(
      "DIRECT COMMUNITY DM DETECTED:",
      text
    );

    const saved =
      await saveUserMessage(
        senderId,
        text,
        messageId
      );

    if (!saved) {
      console.log(
        "Duplicate direct DM ignored:",
        messageId
      );

      return;
    }

    const {
      error:
        createLeadError,
    } = await supabaseAdmin
      .from(
        "community_waitlist_leads"
      )
      .insert({
        instagram_user_id:
          senderId,

        // We intentionally collect
        // this from the user later.
        instagram_username:
          null,

        status:
          "awaiting_confirmation",

        source_comment_id:
          `dm:${messageId}`,

        source_media_id:
          null,

        source_comment_text:
          text,

        updated_at:
          new Date()
            .toISOString(),
      });

    if (
      createLeadError
    ) {
      if (
        createLeadError.code ===
        "23505"
      ) {
        console.log(
          "Direct DM lead already exists"
        );

        return;
      }

      console.error(
        "Failed to create direct DM lead:",
        createLeadError
      );

      return;
    }

    await sendInstagramMessage(
      senderId,
      FIRST_DM
    );

    await saveAssistantMessage(
      senderId,
      FIRST_DM
    );

    console.log(
      "DIRECT DM WAITLIST FUNNEL STARTED:",
      senderId
    );

    return;
  }

  // ==================================================
  // AUTOMATION FINISHED
  // ==================================================

  if (
    lead.status ===
      "waitlisted" ||
    lead.status ===
      "declined"
  ) {
    console.log(
      "Waitlist automation already finished for:",
      senderId
    );

    return;
  }

  // ==================================================
  // SAVE USER MESSAGE
  // DUPLICATE PROTECTION
  // ==================================================

  const saved =
    await saveUserMessage(
      senderId,
      text,
      messageId
    );

  if (!saved) {
    console.log(
      "Duplicate Instagram message ignored:",
      messageId
    );

    return;
  }

  // ==================================================
  // WAITING FOR INSTAGRAM USERNAME
  // ==================================================

  if (
    lead.status ===
    "awaiting_username"
  ) {
    const instagramUsername =
      extractInstagramUsername(
        text
      );

    if (
      !instagramUsername
    ) {
      const reply =
        "what's your Instagram username bro? just send me your @";

      await sendInstagramMessage(
        senderId,
        reply
      );

      await saveAssistantMessage(
        senderId,
        reply
      );

      return;
    }

    await saveInstagramUsername(
      senderId,
      instagramUsername
    );

    console.log(
      "INSTAGRAM USERNAME SAVED:",
      instagramUsername
    );

    const reply =
      "perfect bro, what's the best email to add to the waitlist?";

    await sendInstagramMessage(
      senderId,
      reply
    );

    await saveAssistantMessage(
      senderId,
      reply
    );

    return;
  }

  // ==================================================
  // EMAIL PROVIDED
  // ==================================================

  const email =
    extractEmail(
      text
    );

  if (email) {
    await completeWaitlist(
      senderId,
      email
    );

    return;
  }

  // ==================================================
  // LOAD CONVERSATION HISTORY
  // ==================================================

  const conversation =
    await getConversation(
      senderId
    );

  // ==================================================
  // AI DECIDES NEXT RESPONSE
  // ==================================================

  const decision =
    await generateWaitlistReply({
      status:
        lead.status,

      conversation,
    });

  console.log(
    "WAITLIST AI DECISION:",
    decision
  );

  // ==================================================
  // USER AGREED
  // ASK FOR USERNAME NEXT
  // ==================================================

  if (
    decision.action ===
    "ask_username"
  ) {
    await updateLeadStatus(
      senderId,
      "awaiting_username"
    );
  }

  // ==================================================
  // ASK EMAIL
  // ==================================================

  if (
    decision.action ===
    "ask_email"
  ) {
    await updateLeadStatus(
      senderId,
      "awaiting_email"
    );
  }

  // ==================================================
  // DECLINED
  // ==================================================

  if (
    decision.action ===
    "decline"
  ) {
    await updateLeadStatus(
      senderId,
      "declined"
    );
  }

  // ==================================================
  // SEND AI RESPONSE
  // ==================================================

  await sendInstagramMessage(
    senderId,
    decision.reply
  );

  await saveAssistantMessage(
    senderId,
    decision.reply
  );
}

// ======================================================
// OPENAI WAITLIST CONVERSATION
// ======================================================

async function generateWaitlistReply(
  input: {
    status: string;

    conversation: {
      role:
        | "user"
        | "assistant";

      content: string;
    }[];
  }
): Promise<WaitlistDecision> {
  if (
    !process.env
      .OPENAI_API_KEY
  ) {
    throw new Error(
      "OPENAI_API_KEY is missing"
    );
  }

  const communityPrice =
    process.env
      .COMMUNITY_PRICE_TEXT ??
    "$10/month";

  const response =
    await openai.responses.create({
      model:
        process.env
          .OPENAI_MODEL ??
        "gpt-5.6-luna",

      store: false,

      instructions: `
You handle Instagram DMs for a calisthenics community waitlist.

The person originally either:
- commented "Community" or something similar on an Instagram post/Reel
OR
- directly DMed "Community".

The first message they receive is:

"Hey bro! I saw that you're interested in the calisthenics community. Do you want me to add you to the waitlist for when it releases?"

CURRENT WAITLIST STATUS:
${input.status}

MAIN GOAL:
Help people who genuinely want early access join the waitlist.

WAITLIST SIGNUP ORDER:

1. First confirm that they actually want to join.
2. Once they clearly agree, ask for their Instagram username.
3. After their Instagram username has been collected, ask for their email.
4. After their email is collected, they are on the waitlist.

Do NOT ask for the username and email in the same message.

ABOUT THE COMMUNITY:
- it is focused on calisthenics
- it will help people learn and improve at calisthenics
- it has not launched yet
- the waitlist is for people who want to know when it releases
- do not invent a release date
- the planned price is ${communityPrice}

PRICE RULE:

NEVER proactively mention the price.

Only mention the price if the person directly asks things like:
- how much does it cost
- is it free
- what's the price
- is there a membership fee

If directly asked, honestly say the planned price is ${communityPrice}.

STYLE:
- casual Instagram DM style
- friendly
- concise
- natural
- "bro" is okay when natural
- usually 1 or 2 short sentences
- don't sound corporate
- don't write long paragraphs
- don't pressure them
- don't use fake urgency
- don't use em dashes
- don't use en dashes
- answer their actual question
- don't pretend to be a specific named person
- if directly asked whether responses are automated or AI-generated, answer accurately

CONSENT LOGIC:

If they clearly want to join, examples:
- yes
- yeah
- yep
- sure
- add me
- i'm in
- im in
- i'm down
- im down
- definitely
- 100%
- put me on it
- sign me up

If CURRENT WAITLIST STATUS is "awaiting_confirmation" and they clearly agree:
- action = "ask_username"
- ask for their Instagram username
- say they can just send their @

If CURRENT WAITLIST STATUS is "awaiting_username":
- action = "ask_username"
- ask for their Instagram username

If CURRENT WAITLIST STATUS is "awaiting_email":
- action = "ask_email"
- ask for the best email for the waitlist

If they clearly do NOT want to join:
- action = "decline"
- give a short friendly response
- don't continue selling

If they are unsure or ask a question:
- action = "reply"
- answer naturally
- don't ask for personal details until they actually want to join

IMPORTANT:
- never ask for passwords
- never ask for card details
- never invent offers
- never invent launch dates
`,

      input:
        input.conversation.map(
          (message) => ({
            role:
              message.role,

            content:
              message.content,
          })
        ),

      max_output_tokens:
        150,

      text: {
        verbosity:
          "low",

        format: {
          type:
            "json_schema",

          name:
            "community_waitlist_decision",

          strict:
            true,

          schema: {
            type:
              "object",

            properties: {
              reply: {
                type:
                  "string",
              },

              action: {
                type:
                  "string",

                enum: [
                  "reply",
                  "ask_username",
                  "ask_email",
                  "decline",
                ],
              },
            },

            required: [
              "reply",
              "action",
            ],

            additionalProperties:
              false,
          },
        },
      },
    });

  if (
    !response.output_text
  ) {
    throw new Error(
      "OpenAI returned no output"
    );
  }

  return JSON.parse(
    response.output_text
  ) as WaitlistDecision;
}

// ======================================================
// SAVE USERNAME
// ======================================================

async function saveInstagramUsername(
  senderId: string,
  username: string
) {
  const cleaned =
    username
      .replace(
        /^@/,
        ""
      )
      .trim();

  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .update({
      instagram_username:
        cleaned,

      status:
        "awaiting_email",

      updated_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "instagram_user_id",
      senderId
    );

  if (error) {
    console.error(
      "Instagram username save failed:",
      error
    );

    throw error;
  }
}

// ======================================================
// EXTRACT INSTAGRAM USERNAME
// ======================================================

function extractInstagramUsername(
  text: string
): string | null {
  // Don't mistake an email for an IG username.
  if (
    extractEmail(text)
  ) {
    return null;
  }

  const trimmed =
    text.trim();

  // Example:
  // @aaravb_sw

  const atMatch =
    trimmed.match(
      /@([A-Za-z0-9._]{1,30})/
    );

  if (
    atMatch?.[1]
  ) {
    return atMatch[1];
  }

  // Examples:
  // username is aaravb_sw
  // instagram: aaravb_sw
  // ig is aaravb_sw

  const phraseMatch =
    trimmed.match(
      /(?:instagram|username|user|ig)\s*(?:username\s*)?(?:is|:|=)?\s*@?([A-Za-z0-9._]{1,30})/i
    );

  if (
    phraseMatch?.[1]
  ) {
    return phraseMatch[1];
  }

  // Just username:
  // aaravb_sw

  if (
    /^@?[A-Za-z0-9._]{1,30}$/.test(
      trimmed
    )
  ) {
    return trimmed.replace(
      /^@/,
      ""
    );
  }

  return null;
}

// ======================================================
// COMPLETE WAITLIST
// ======================================================

async function completeWaitlist(
  senderId: string,
  email: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .update({
      email:
        email.toLowerCase(),

      status:
        "waitlisted",

      updated_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "instagram_user_id",
      senderId
    );

  if (error) {
    console.error(
      "Failed to save waitlist email:",
      error
    );

    return;
  }

  const confirmation =
    "you're on the waitlist bro, i'll let you know when it releases 🤝";

  await sendInstagramMessage(
    senderId,
    confirmation
  );

  await saveAssistantMessage(
    senderId,
    confirmation
  );

  console.log(
    "WAITLIST SIGNUP COMPLETE:",
    {
      senderId,
      email,
    }
  );
}

// ======================================================
// LOAD CONVERSATION
// ======================================================

async function getConversation(
  senderId: string
) {
  const {
    data,
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .select(
      "role, content, created_at"
    )
    .eq(
      "instagram_user_id",
      senderId
    )
    .order(
      "created_at",
      {
        ascending:
          false,
      }
    )
    .limit(20);

  if (error) {
    console.error(
      "Conversation loading failed:",
      error
    );

    throw error;
  }

  return (
    data ?? []
  )
    .reverse()
    .map(
      (message) => ({
        role:
          message.role as
            | "user"
            | "assistant",

        content:
          message.content,
      })
    );
}

// ======================================================
// SAVE USER MESSAGE
// ======================================================

async function saveUserMessage(
  senderId: string,
  text: string,
  messageId: string
): Promise<boolean> {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .insert({
      instagram_user_id:
        senderId,

      instagram_message_id:
        messageId,

      role:
        "user",

      content:
        text,
    });

  if (!error) {
    return true;
  }

  if (
    error.code ===
    "23505"
  ) {
    return false;
  }

  console.error(
    "User message save failed:",
    error
  );

  throw error;
}

// ======================================================
// SAVE ASSISTANT MESSAGE
// ======================================================

async function saveAssistantMessage(
  senderId: string,
  text: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .insert({
      instagram_user_id:
        senderId,

      role:
        "assistant",

      content:
        text,
    });

  if (error) {
    console.error(
      "Assistant message save failed:",
      error
    );
  }
}

// ======================================================
// UPDATE LEAD STATUS
// ======================================================

async function updateLeadStatus(
  senderId: string,
  status: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .update({
      status,

      updated_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "instagram_user_id",
      senderId
    );

  if (error) {
    console.error(
      "Lead status update failed:",
      error
    );
  }
}

// ======================================================
// EMAIL EXTRACTION
// ======================================================

function extractEmail(
  text: string
) {
  const match =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );

  return (
    match?.[0] ??
    null
  );
}

// ======================================================
// COMMUNITY TRIGGER
// ======================================================

function isCommunityTrigger(
  text: string
) {
  const words =
    text
      .toLowerCase()
      .match(/[a-z]+/g) ??
    [];

  const target =
    "community";

  for (
    const word of words
  ) {
    if (
      word === target
    ) {
      return true;
    }

    if (
      word.length < 6
    ) {
      continue;
    }

    if (
      levenshteinDistance(
        word,
        target
      ) <= 2
    ) {
      return true;
    }
  }

  return false;
}

// ======================================================
// LEVENSHTEIN DISTANCE
// ======================================================

function levenshteinDistance(
  a: string,
  b: string
) {
  const matrix:
    number[][] =
      Array.from(
        {
          length:
            b.length + 1,
        },
        () =>
          Array(
            a.length + 1
          ).fill(0)
      );

  for (
    let i = 0;
    i <= b.length;
    i++
  ) {
    matrix[i][0] =
      i;
  }

  for (
    let j = 0;
    j <= a.length;
    j++
  ) {
    matrix[0][j] =
      j;
  }

  for (
    let i = 1;
    i <= b.length;
    i++
  ) {
    for (
      let j = 1;
      j <= a.length;
      j++
    ) {
      if (
        b[i - 1] ===
        a[j - 1]
      ) {
        matrix[i][j] =
          matrix[
            i - 1
          ][
            j - 1
          ];
      } else {
        matrix[i][j] =
          Math.min(
            matrix[
              i - 1
            ][
              j - 1
            ] + 1,

            matrix[i][
              j - 1
            ] + 1,

            matrix[
              i - 1
            ][j] + 1
          );
      }
    }
  }

  return matrix[
    b.length
  ][
    a.length
  ];
}

// ======================================================
// PRIVATE REPLY FROM COMMENT
// ======================================================

async function sendPrivateReply(
  commentId: string,
  text: string
) {
  const accessToken =
    process.env
      .INSTAGRAM_ACCESS_TOKEN;

  const accountId =
    process.env
      .INSTAGRAM_ACCOUNT_ID;

  const version =
    process.env
      .INSTAGRAM_GRAPH_VERSION ??
    "v26.0";

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

  const response =
    await fetch(
      `https://graph.instagram.com/${version}/${accountId}/messages`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            recipient: {
              comment_id:
                commentId,
            },

            message: {
              text,
            },
          }),
      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {
    console.error(
      "Instagram private reply error:",
      data
    );

    throw new Error(
      "Instagram private reply failed"
    );
  }

  return data;
}

// ======================================================
// NORMAL INSTAGRAM DM
// ======================================================

async function sendInstagramMessage(
  recipientId: string,
  text: string
) {
  const accessToken =
    process.env
      .INSTAGRAM_ACCESS_TOKEN;

  const accountId =
    process.env
      .INSTAGRAM_ACCOUNT_ID;

  const version =
    process.env
      .INSTAGRAM_GRAPH_VERSION ??
    "v26.0";

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

  const response =
    await fetch(
      `https://graph.instagram.com/${version}/${accountId}/messages`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            recipient: {
              id:
                recipientId,
            },

            message: {
              text,
            },
          }),
      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {
    console.error(
      "Instagram DM error:",
      data
    );

    throw new Error(
      "Instagram DM failed"
    );
  }

  return data;
}

// ======================================================
// VERIFY INSTAGRAM WEBHOOK SIGNATURE
// ======================================================

function verifyInstagramSignature(
  req: NextRequest,
  rawBody: string
) {
  const appSecret =
    process.env
      .INSTAGRAM_APP_SECRET;

  if (!appSecret) {
    console.error(
      "INSTAGRAM_APP_SECRET is missing"
    );

    return false;
  }

  const signature =
    req.headers.get(
      "x-hub-signature-256"
    );

  if (!signature) {
    console.error(
      "x-hub-signature-256 is missing"
    );

    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac(
        "sha256",
        appSecret
      )
      .update(
        rawBody
      )
      .digest(
        "hex"
      );

  const actualBuffer =
    Buffer.from(
      signature
    );

  const expectedBuffer =
    Buffer.from(
      expected
    );

  if (
    actualBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    actualBuffer,
    expectedBuffer
  );
}