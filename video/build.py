"""Assemble the Guardian demo video from recorded scene clips + Edge TTS narration.

Usage: PYTHONUTF8=1 python build.py  (run after record.mjs; needs out/clips.json)
Output: out/guardian-demo.mp4
"""
import asyncio, json, os, subprocess, sys
import edge_tts, imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
VOICE = "en-US-AndrewMultilingualNeural"
FPS = 30
OUT = "out"
os.makedirs(f"{OUT}/audio", exist_ok=True); os.makedirs(f"{OUT}/scenes", exist_ok=True)

# Scene order and narration. Video is cut to clips.json keep-segments; if the kept
# video is shorter than the narration the last frame is held.
SCENES = [
    ("problem", "Today an emergency pause is either an admin key or a bot reacting to a CVSS score. "
                "One trusts a few people. The other pauses things that were never exploitable in this deployment."),
    ("judge", "Guardian is a GenLayer Intelligent Contract. A protocol declares on-chain what it actually runs, "
              "and the policy it commits to. When a public advisory appears, every validator fetches it independently, "
              "decides whether it applies to this deployment, and derives the action from that policy. "
              "Deterministic checks come first. The language model is asked one boolean, only when severity reaches the pause threshold."),
    ("vault-a", "A real advisory: lodash prototype pollution. vault-a runs 4.17.15 and merges untrusted JSON with set and zipObjectDeep. "
                "The keeper submits the check. Validators reach consensus, and RESTRICT lands on the vault the moment the transaction is accepted. "
                "PAUSE lands only after finality. Optimistic finality becomes risk escalation, and the verdict sits on-chain for anyone to read."),
    ("vault-c", "Same advisory, same lodash version. vault-c uses lodash only for chunk and uniq on internal constants. "
                "Validators judge the exploit prerequisite not met, so high severity is clamped to RESTRICT. Policy, not CVSS, decided."),
    ("vault-b", "vault-b is patched. The version is outside the affected range, so the action is NONE, and no language model was even asked."),
    ("demo-repo", "This advisory was published by a human on a demo repository. Guardian reads it straight from the GitHub API. "
                  "demo-repo runs version 1.2.0, inside the affected range. Publish to pause in minutes, and anyone can reproduce it on their own repository."),
    ("recovery", "Recovery is not an admin call either. The protocol upgrades the dependency and asks for resume. "
                 "Validators re-check the evidence against the new manifest, find it no longer affected, and only then does the vault return to normal."),
    ("numbers", "We measured validator consistency: five identical targets, six advisories, thirty transactions per version. "
                "Moving consensus to outcome enums and gating the language model took disagreement from eighteen votes to zero, with every run logged."),
    ("bradbury", "Guardian is also live on Bradbury testnet, with twenty-one real transactions signed from our wallet, and verdicts identical to Studionet."),
    ("close", "A deployed contract, a keeper anyone can run, and a policy the protocol owns. Guardian, for the Autonomous Protocols track. Thank you."),
]


def run(args):
    r = subprocess.run([FF, "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        print(r.stderr); sys.exit(1)


def duration(path):
    r = subprocess.run([FF, "-i", path], capture_output=True, text=True)
    d = r.stderr.split("Duration: ")[1][:11]
    h, m, s = d.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


async def tts(text, path):
    if not os.path.exists(path):
        await edge_tts.Communicate(text, VOICE, rate="-4%").save(path)
    return duration(path)


def main():
    clips = {c["name"]: c for c in json.load(open(f"{OUT}/clips.json"))}
    parts = []
    total = 0.0
    for name, text in SCENES:
        clip = clips.get(name)
        if not clip:
            print(f"missing clip {name}"); sys.exit(1)
        if clip.get("error"):
            print(f"warning: {name} recorded with error: {clip['error']}")
        audio = f"{OUT}/audio/{name}.mp3"
        a_dur = asyncio.run(tts(text, audio))
        segs = [(a, b) for a, b in clip["keep"] if b - a > 0.2]
        v_dur = sum(b - a for a, b in segs)
        target = max(v_dur, a_dur + 0.6)
        # trim+concat kept segments, hold last frame to target length
        fc = "".join(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];" for i, (a, b) in enumerate(segs))
        fc += "".join(f"[v{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[vc];"
        fc += f"[vc]fps={FPS},tpad=stop_mode=clone:stop_duration={max(0, target - v_dur) + 0.05:.3f},trim=duration={target:.3f},setpts=PTS-STARTPTS[vout];"
        fc += f"[1:a]adelay=300|300,apad=whole_dur={target:.3f}[aout]"
        out = f"{OUT}/scenes/{name}.mp4"
        run(["-i", clip["file"], "-i", audio, "-filter_complex", fc, "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-shortest", out])
        d = duration(out); total += d
        print(f"{name:10s} video={v_dur:6.1f}s audio={a_dur:6.1f}s -> {d:6.1f}s")
        parts.append(out)
    with open(f"{OUT}/concat.txt", "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    final = f"{OUT}/guardian-demo.mp4"
    run(["-f", "concat", "-safe", "0", "-i", f"{OUT}/concat.txt", "-c", "copy", "-movflags", "+faststart", final])
    print(f"\n{final}  {duration(final):.1f}s  ({os.path.getsize(final)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
