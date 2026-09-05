import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  ) {
    return new NextResponse(challenge ?? "", {
      status: 200,
    });
  }

  return new NextResponse("Forbidden", {
    status: 403,
  });
}

export async function POST() {
  return NextResponse.json({
    received: true,
  });
}