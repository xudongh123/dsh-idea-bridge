#!/bin/bash
# Build the IDEA-side plugin without Gradle: compile against the jars shipped
# inside the IntelliJ installation, then package a plain JAR.
#
# The platform jars are compiled for the IDE's own Java (class file 69 in
# 2026.2), so the compiler must come from the bundled JetBrains Runtime —
# a system JDK 17 cannot even read them.
set -euo pipefail

IDEA_APP="${IDEA_APP:-/Applications/IntelliJ IDEA.app}"
JAVAC="${JAVAC:-$IDEA_APP/Contents/jbr/Contents/Home/bin/javac}"
JAR_TOOL="${JAR_TOOL:-jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
JAR="$OUT/dsh-idea-bridge.jar"

rm -rf "$OUT"
mkdir -p "$OUT/classes"

"$JAVAC" \
  -cp "$IDEA_APP/Contents/lib/*" \
  -d "$OUT/classes" \
  $(find "$HERE/src" -name '*.java')

cp -R "$HERE/resources/." "$OUT/classes/"

"$JAR_TOOL" --create --file "$JAR" -C "$OUT/classes" .

echo "built: $JAR"
