// app/providers/SocketProvider.tsx
"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Socket } from "socket.io-client";
import { socket } from "@lib/socket";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useTradingConfigStore } from "@hooks/useConfig";

interface SocketData {
  event: string;
  payload: any;
}

interface SocketContextValue {
  connected: boolean;
  lastMessage: SocketData | null;
  send: (event: string, payload?: any) => void;
  socket?: Socket | null;
}

const SocketContext = createContext<SocketContextValue>({
  connected: false,
  lastMessage: null,
  send: () => {},
  socket: null,
});

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<SocketData | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const { publicKey } = useSolanaWallet();
  const { autoTrade, amount } = useTradingConfigStore();

  useEffect(() => {
    // Attach to the shared singleton (frontend/lib/socket.ts) rather than
    // creating a new connection here — see that file for why.
    socketRef.current = socket;
    if (socket.connected) setConnected(true);

    // This provider and every useSocket() call elsewhere in the app (21+
    // components) all attach listeners to this one shared singleton, several
    // for the same event names ("connect", "tradeFeed", "pnl:update", etc).
    // The cleanup below used to call socket.off("eventName") with no handler
    // reference, which removes EVERY listener for that event — including
    // every other still-mounted useSocket() instance's — not just this
    // provider's own. In dev, React 18 Strict Mode's mount->cleanup->remount
    // cycle alone was enough to trigger this and silently kill live updates
    // elsewhere in the app. Named handlers + matching off() calls fix it.
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = () => setConnected(false);
    const onUpdate = (data: any) => {
      setLastMessage({
        event: data?.event ?? "update",
        payload: data?.payload ?? data,
      });
    };
    const onTradeFeed = (payload: any) =>
      setLastMessage({ event: "tradeFeed", payload });
    const onTokenFeed = (payload: any) =>
      setLastMessage({ event: "tokenFeed", payload });
    const onPriceUpdate = (payload: any) =>
      setLastMessage({ event: "priceUpdate", payload });
    const onValidationResult = (payload: any) =>
      setLastMessage({ event: "validationResult", payload });
    const onTradeError = (payload: any) =>
      setLastMessage({ event: "tradeError", payload });
    const onPnlUpdate = (payload: any) =>
      setLastMessage({ event: "pnl:update", payload });
    const onWalletBalance = (payload: any) =>
      setLastMessage({ event: "wallet:balance", payload });
    const onTrailingUpdate = (payload: any) =>
      setLastMessage({ event: "position:trailingUpdate", payload });

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("update", onUpdate);
    socket.on("tradeFeed", onTradeFeed);
    socket.on("tokenFeed", onTokenFeed);
    socket.on("priceUpdate", onPriceUpdate);
    socket.on("validationResult", onValidationResult);
    socket.on("tradeError", onTradeError);
    socket.on("pnl:update", onPnlUpdate);
    socket.on("wallet:balance", onWalletBalance);
    socket.on("position:trailingUpdate", onTrailingUpdate);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("update", onUpdate);
      socket.off("tradeFeed", onTradeFeed);
      socket.off("tokenFeed", onTokenFeed);
      socket.off("priceUpdate", onPriceUpdate);
      socket.off("validationResult", onValidationResult);
      socket.off("tradeError", onTradeError);
      socket.off("pnl:update", onPnlUpdate);
      socket.off("wallet:balance", onWalletBalance);
      socket.off("position:trailingUpdate", onTrailingUpdate);
    };
  }, []);

  // Identify wallet when connected
  useEffect(() => {
    if (connected && publicKey && socketRef.current) {
      console.log("🆔 Identifying wallet with backend:", publicKey.toString());
      socketRef.current.emit("identify", {
        wallet: publicKey.toString(),
        autoMode: autoTrade,
        manualAmountSol: amount,
      });
    }
  }, [connected, publicKey, autoTrade, amount]);

  const send = (event: string, payload?: any) => {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit(event, payload);
    }
  };

  return (
    <SocketContext.Provider
      value={{ connected, lastMessage, send, socket: socketRef.current }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export const useSocketContext = () => useContext(SocketContext);
