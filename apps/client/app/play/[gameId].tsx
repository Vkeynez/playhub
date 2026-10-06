import { useLocalSearchParams } from 'expo-router';

import { GameHost } from '../../src/host/GameHost';

export default function PlayScreen() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  return <GameHost gameId={String(gameId)} />;
}
