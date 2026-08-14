"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { AlertTriangle } from "lucide-react";
import { useManualBuy } from "@hooks/useManualBuy";

export function ManualBuyPanel() {
  const [tokenMint, setTokenMint] = useState("");
  const [amountSol, setAmountSol] = useState("0.1");
  const [slippage, setSlippage] = useState("10");
  const [showWarning, setShowWarning] = useState(true);

  const { executeManualBuy, loading } = useManualBuy();

  const handleManualBuy = async () => {
    if (!tokenMint || !amountSol) {
      return;
    }

    await executeManualBuy({
      tokenMint,
      amountSol: parseFloat(amountSol),
      slippage: parseFloat(slippage),
    });
  };

  return (
    <Card className="border-orange-500/20 bg-black/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-orange-500">
          <AlertTriangle className="h-5 w-5" />
          Manual Buy (No Validations)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {showWarning && (
          <div className="bg-red-950/30 border border-red-500/50 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-200">
                <strong>⚠️ WARNING:</strong> Manual buy skips ALL safety checks:
                <ul className="mt-2 ml-4 list-disc space-y-1 text-xs text-red-300">
                  <li>No liquidity validation</li>
                  <li>No authority checks (mint/freeze)</li>
                  <li>No tax verification</li>
                  <li>No price impact limits</li>
                  <li>No honeypot detection</li>
                </ul>
                <p className="mt-2 text-xs font-semibold text-red-100">
                  You assume FULL responsibility. DYOR!
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-6 text-xs text-red-300 hover:text-red-100"
                  onClick={() => setShowWarning(false)}
                >
                  I understand the risks
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="tokenMint">Token Mint Address</Label>
          <Input
            id="tokenMint"
            placeholder="Enter token mint address..."
            value={tokenMint}
            onChange={(e) => setTokenMint(e.target.value)}
            className="bg-black/60 border-gray-700"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="amountSol">Amount (SOL)</Label>
            <Input
              id="amountSol"
              type="number"
              step="0.01"
              min="0.001"
              placeholder="0.1"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              className="bg-black/60 border-gray-700"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slippage">Slippage (%)</Label>
            <Input
              id="slippage"
              type="number"
              step="1"
              min="1"
              max="50"
              placeholder="10"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              className="bg-black/60 border-gray-700"
            />
          </div>
        </div>

        <Button
          onClick={handleManualBuy}
          disabled={loading || !tokenMint || !amountSol}
          className="w-full bg-orange-600 hover:bg-orange-700"
        >
          {loading ? "Executing..." : "⚠️ Execute Manual Buy"}
        </Button>

        <p className="text-xs text-gray-500 text-center">
          No amount limits • No validation • User discretion only
        </p>
      </CardContent>
    </Card>
  );
}
