import { useLocalSearchParams } from 'expo-router';

import { RoomScreen } from '../../src/lobby/RoomScreen';

export default function RoomRoute() {
  const { id, watch } = useLocalSearchParams<{ id: string; watch?: string }>();
  return <RoomScreen key={`${id}:${watch ?? ''}`} roomId={String(id)} watch={watch === '1'} />;
}
