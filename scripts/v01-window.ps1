param(
    [string]$Op,
    [long]$Hwnd = 0,
    [double]$Ratio = 1.0
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class WOps {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@

$h = [IntPtr]$Hwnd

switch ($Op) {
    "minimize" {
        [WOps]::ShowWindow($h, 6) | Out-Null
        Write-Output "minimized"
    }
    "restore" {
        [WOps]::ShowWindow($h, 9) | Out-Null
        [WOps]::SetForegroundWindow($h) | Out-Null
        Write-Output "restored"
    }
    "cover" {
        Add-Type -AssemblyName System.Windows.Forms
        $r = New-Object RECT
        [WOps]::GetWindowRect($h, [ref]$r) | Out-Null
        $f = New-Object System.Windows.Forms.Form
        $f.StartPosition = 'Manual'
        $f.Location = New-Object System.Drawing.Point($r.Left, $r.Top)
        $f.Size = New-Object System.Drawing.Size([int](($r.Right - $r.Left) * $Ratio), [int](($r.Bottom - $r.Top) * $Ratio))
        $f.TopMost = $true
        $f.ShowInTaskbar = $false
        $f.Text = 'v01cover'
        $f.Add_Shown({ $f.Activate() })
        [void]$f.ShowDialog()
    }
    default {
        Write-Error "unknown op $Op"
    }
}
