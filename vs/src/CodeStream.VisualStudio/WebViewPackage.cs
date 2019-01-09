﻿using CodeStream.VisualStudio.UI.ToolWindows;
using Microsoft.VisualStudio.Shell;
using System;
using System.Runtime.InteropServices;

namespace CodeStream.VisualStudio
{
    /// <summary>
    /// This is the host package for the <see cref="WebViewToolWindow"/> tool window.
    /// </summary>
    /// <remarks>
    /// This package mustn't use MEF.
    /// See: https://github.com/github/VisualStudio/issues/1550
    /// </remarks>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(Guids.WebViewPackageId)]
    [ProvideToolWindow(typeof(WebViewToolWindow), Orientation = ToolWindowOrientation.Right,
        Style = VsDockStyle.Tabbed, Window = EnvDTE.Constants.vsWindowKindSolutionExplorer)]
    public sealed class WebViewPackage : AsyncPackage  { }
}