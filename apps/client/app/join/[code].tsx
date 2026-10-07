import { useLocalSearchParams } from 'expo-router';

import { JoinScreen } from '../../src/lobby/JoinScreen';

export default function JoinRoute() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <JoinScreen key={String(code)} rawCode={String(code ?? '')} />;
}
