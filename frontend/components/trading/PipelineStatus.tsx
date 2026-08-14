"use client";

import React, { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { useJupiterEvents } from "@hooks/useJupiterEvents";
import {
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export const PipelineStatus: React.FC = () => {
  const { pipelineFailed, pipelineSuccess, connected } = useJupiterEvents();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const allEvents = [
    ...pipelineSuccess.map((e) => ({ ...e, type: "success" as const })),
    ...pipelineFailed.map((e) => ({ ...e, type: "failed" as const })),
  ].sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeB - timeA;
  });

  // Must match validationPipeline.service.ts's real stageName values exactly
  // — this array only backfills labels for stages a failed run never reached.
  const stageNames = [
    "Jupiter Discovery",
    "Jupiter Routing Test",
    "Authority Check",
    "Birdeye Market Health",
    "Jupiter Pre-Execution",
    "Jupiter Buy Execution",
  ];

  const toggleExpand = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index);
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="text-lg font-semibold text-primary">
          6-Stage Pipeline Activity
        </CardTitle>

        <div
          className={`flex items-center gap-2 text-xs ${
            connected ? "text-green-400" : "text-red-400"
          }`}
        >
          <Clock className="w-4 h-4" />
          {connected ? "Live" : "Offline"}
        </div>
      </CardHeader>

      <CardContent>
        {allEvents.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">
            No pipeline activity yet. Waiting for tokens...
          </div>
        ) : (
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {allEvents.slice(0, 20).map((event, index) => (
              <div
                key={`${event.mint}-${event.timestamp}-${index}`}
                className={`border rounded-lg transition ${
                  event.type === "success"
                    ? "bg-emerald-500/5 border-emerald-500/20"
                    : "bg-red-500/5 border-red-500/20"
                }`}
              >
                {/* Header */}
                <div
                  className="p-3 flex items-center justify-between cursor-pointer hover:bg-base-300/30 transition"
                  onClick={() => toggleExpand(index)}
                >
                  <div className="flex items-center gap-3">
                    {event.type === "success" ? (
                      <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                    )}

                    <div>
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-mono text-gray-300">
                          {event.mint.slice(0, 8)}...
                        </code>
                        {event.type === "success" ? (
                          <span className="text-xs text-emerald-400 font-medium">
                            ✅ All Stages Passed
                          </span>
                        ) : (
                          <span className="text-xs text-red-400 font-medium">
                            ❌ Stage {event.failedStage} Failed
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {formatTime(event.timestamp)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {event.type === "success" && (
                      <a
                        href={`https://solscan.io/tx/${event.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-emerald-400 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View Tx
                      </a>
                    )}
                    {expandedIndex === index ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedIndex === index && (
                  <div className="px-3 pb-3 border-t border-base-300/50">
                    <div className="mt-2 space-y-2">
                      {event.type === "success" ? (
                        <>
                          {/* Success Details */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-gray-400">Tokens:</span>{" "}
                              <span className="text-gray-300">
                                {event.tokensReceived != null
                                  ? event.tokensReceived.toLocaleString()
                                  : "—"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400">Price:</span>{" "}
                              <span className="text-gray-300">
                                {event.actualPrice != null
                                  ? `${event.actualPrice.toFixed(8)} SOL`
                                  : "—"}
                              </span>
                            </div>
                          </div>

                          {/* Stage Progress */}
                          <div className="mt-3">
                            <div className="text-xs text-gray-400 mb-2">
                              Pipeline Stages:
                            </div>
                            <div className="space-y-1">
                              {event.results?.map((result: any, i: number) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-2 text-xs"
                                >
                                  <CheckCircle className="w-3 h-3 text-emerald-400" />
                                  <span className="text-gray-300">
                                    Stage {result.stage}: {result.stageName}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Failure Details */}
                          <div className="text-xs">
                            <div className="text-red-400 font-medium mb-1">
                              Failed at: {event.failedStageName}
                            </div>
                            <div className="text-gray-300 bg-base-300/30 p-2 rounded">
                              {event.reason}
                            </div>
                          </div>

                          {/* Stage Progress */}
                          <div className="mt-3">
                            <div className="text-xs text-gray-400 mb-2">
                              Pipeline Progress:
                            </div>
                            <div className="space-y-1">
                              {event.results?.map((result: any, i: number) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-2 text-xs"
                                >
                                  {result.passed ? (
                                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                                  ) : (
                                    <XCircle className="w-3 h-3 text-red-400" />
                                  )}
                                  <span
                                    className={
                                      result.passed
                                        ? "text-gray-300"
                                        : "text-red-400"
                                    }
                                  >
                                    Stage {result.stage}: {result.stageName}
                                  </span>
                                </div>
                              ))}
                              {/* Show remaining stages as not reached */}
                              {Array.from({
                                length: 6 - (event.results?.length || 0),
                              }).map((_, i) => (
                                <div
                                  key={`remaining-${i}`}
                                  className="flex items-center gap-2 text-xs opacity-50"
                                >
                                  <Clock className="w-3 h-3 text-gray-400" />
                                  <span className="text-gray-400">
                                    Stage {(event.results?.length || 0) + i + 1}
                                    :{" "}
                                    {
                                      stageNames[
                                        (event.results?.length || 0) + i
                                      ]
                                    }
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Summary Stats */}
        <div className="mt-4 pt-4 border-t border-base-300">
          <div className="grid grid-cols-2 gap-4 text-center text-xs">
            <div>
              <div className="text-emerald-400 text-2xl font-bold">
                {pipelineSuccess.length}
              </div>
              <div className="text-gray-400">Successful Buys</div>
            </div>
            <div>
              <div className="text-red-400 text-2xl font-bold">
                {pipelineFailed.length}
              </div>
              <div className="text-gray-400">Failed Validations</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default PipelineStatus;
