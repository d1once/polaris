import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  projectId: z.string(),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { projectId } = parsed.data;

  const internalKey = process.env.POLARIS_INTERNAL_KEY;
  if (!internalKey) {
    return NextResponse.json(
      { error: "Internal key not found" },
      { status: 500 },
    );
  }

  // Verify user has access to the project
  const ownership = await convex.query(api.system.verifyProjectOwnership, {
    internalKey,
    projectId: projectId as Id<"projects">,
    userId,
  });

  if (!ownership.authorized) {
    return new Response("Forbidden", { status: 403 });
  }

  // Find all processing messages in this project
  const processingMessages = await convex.query(
    api.system.getProcessingMessages,
    {
      internalKey,
      projectId: projectId as Id<"projects">,
    },
  );

  if (processingMessages.length === 0) {
    return NextResponse.json({ success: true, cancelled: false });
  }

  // Cancel all processing messages with per-message error handling
  const results = await Promise.allSettled(
    processingMessages.map(async (msg) => {
      // Update status first to prevent race conditions
      await convex.mutation(api.system.updateMessageStatus, {
        internalKey,
        messageId: msg._id,
        status: "cancelled",
      });
      await inngest.send({
        name: "messages/cancel",
        data: {
          messageId: msg._id,
        },
      });
      return msg._id;
    }),
  );

  const cancelledIds: string[] = [];
  const failedResults: { messageId: string; error: string }[] = [];

  results.forEach((result, i) => {
    const messageId = processingMessages[i]._id;
    if (result.status === "fulfilled") {
      cancelledIds.push(result.value);
    } else {
      failedResults.push({
        messageId,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });

  return NextResponse.json({
    success: failedResults.length === 0,
    cancelled: cancelledIds.length > 0,
    cancelledIds,
    failedIds: failedResults,
  });
}
