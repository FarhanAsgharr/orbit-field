/**
 * Top-level error boundary.
 *
 * A crash here is not merely a bad user experience — an inspector mid-checklist
 * with unsynced answers needs reassurance that their work is safe, and a route
 * back to it. The recovery screen therefore says explicitly that queued work is
 * retained, because the alternative reading ("I've lost my morning") is what
 * makes people stop trusting the app.
 */

import * as Application from 'expo-application';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  errorInfo: string | null;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Logged rather than reported to a third party: inspection data is
    // commercially sensitive and a stack trace can contain it.
    console.error('[orbit] unhandled render error', error, info.componentStack);
    this.setState({ errorInfo: info.componentStack ?? null });
  }

  private reset = (): void => {
    this.setState({ error: null, errorInfo: null });
  };

  override render(): React.ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.icon}>⚠</Text>
          <Text style={styles.title}>Something went wrong</Text>

          <Text style={styles.reassurance}>
            Your inspection data is safe. Everything you have entered is stored on this device and
            will sync when the app restarts.
          </Text>

          <View style={styles.detail}>
            <Text style={styles.detailLabel}>Details</Text>
            <Text style={styles.detailText}>{error.message}</Text>
            {errorInfo ? (
              <Text style={styles.stack} numberOfLines={12}>
                {errorInfo.trim()}
              </Text>
            ) : null}
            <Text style={styles.version}>
              Orbit Field {Application.nativeApplicationVersion ?? '1.0.0'} (
              {Application.nativeBuildVersion ?? 'dev'})
            </Text>
          </View>

          <Text style={styles.action} onPress={this.reset}>
            Try again
          </Text>
        </ScrollView>
      </View>
    );
  }
}

// Static styles: the boundary must render even if the theme provider is what
// threw, so it cannot depend on theme context.
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0F1A' },
  content: { padding: 24, paddingTop: 96, gap: 16 },
  icon: { fontSize: 44, color: '#E08600', textAlign: 'center' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: '#F5F8FC', textAlign: 'center' },
  reassurance: {
    fontSize: 16,
    lineHeight: 24,
    color: '#94A3BC',
    textAlign: 'center',
    marginBottom: 8,
  },
  detail: {
    backgroundColor: '#111726',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#232C3D',
    padding: 16,
    gap: 8,
  },
  detailLabel: { fontSize: 12, fontWeight: '600', color: '#6B7C9B', letterSpacing: 0.4 },
  detailText: { fontSize: 14, lineHeight: 20, color: '#E2E8F0' },
  stack: { fontSize: 11, lineHeight: 16, color: '#6B7C9B', fontFamily: 'Menlo' },
  version: { fontSize: 12, color: '#4A5A78', marginTop: 8 },
  action: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3B7BFF',
    textAlign: 'center',
    paddingVertical: 16,
    marginTop: 8,
  },
});
